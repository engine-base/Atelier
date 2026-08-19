"""GAP-164: 会話から再利用できるノウハウを自動でナレッジに残す。

経営者の疑問 (2026-08-19):
  「チャット部分に学習に使われませんと書いているけど、いいものは自動でナレッジ的に
   する状況にしていなかったっけ？？ここら辺がわかっていないけど」

**それまでの実態**: 会話 → ナレッジの自動蓄積は未実装だった。
GAP-153 のキュレーションは「すでにナレッジになっているもの」を運営が匿名化して
全アカウントへ広げる層で、入口 (会話からナレッジを作る) が無かった。

ここで入れるのはその入口:
  - スレッドのローリング要約更新と同じタイミングで、直近の会話から
    **他の案件でも使える形に一般化できるノウハウ**だけを抽出する。
  - 抽出は **本人のサブスク経路 (relay → agent_sdk → API)** で走る。運営費用ではない。
  - 保存先は **そのワークスペースのナレッジ** (account_type=workspace / scope=common)。
    source_type='ai_extracted' なので画面で「AI が会話から拾ったもの」と分かり、
    不要なら消せる。**外部のモデル学習には一切使わない** (鉄則: AI 学習デフォルト OFF)。
  - 似た題のナレッジが既にあれば作らない (重複で埋めない)。
  - 抽出できなければ何も作らない。**でっち上げない**。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

MIN_MESSAGES = 4
MAX_MESSAGES = 20
MAX_PER_RUN = 2

_SYSTEM = (
    "あなたは開発案件の会話から「他の案件でも再利用できるノウハウ」だけを抜き出す担当です。\n"
    "厳守:\n"
    "1) 出力は JSON 配列のみ。説明・コードフェンス禁止。\n"
    '2) 各要素は {"title": 40字以内, "content_md": 400字以内, "category": 短い語, '
    '"tags": 文字列配列}。\n'
    "3) **この案件固有の事実 (社名・人名・金額・URL・日付・固有の要望) は書かない**。\n"
    "   一般化できないものは採用しない。\n"
    "4) 手順・判断基準・失敗の回避策など、次に活きるものだけ。雑談・進捗報告は不要。\n"
    "5) 該当が無ければ [] を返す。無理に作らない。\n"
    "6) 最大 2 件。"
)


def _strip_fence(t: str) -> str:
    t = t.strip()
    if t.startswith("```"):
        nl = t.find("\n")
        if nl >= 0:
            t = t[nl + 1 :]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def parse_candidates(raw: str) -> list[dict[str, Any]]:
    """LLM 出力を候補リストにする。壊れていれば空 (推測で補わない)。"""
    try:
        data = json.loads(_strip_fence(raw))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out: list[dict[str, Any]] = []
    for item in data[:MAX_PER_RUN]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()[:120]
        body = str(item.get("content_md") or "").strip()[:1200]
        if not title or len(body) < 20:
            continue
        tags_raw = item.get("tags")
        tags = [str(t)[:40] for t in tags_raw[:5]] if isinstance(tags_raw, list) else []
        out.append(
            {
                "title": title,
                "content_md": body,
                "category": str(item.get("category") or "ノウハウ").strip()[:40],
                "tags": [*tags, "auto"],
            }
        )
    return out


async def _thread_context(
    session: AsyncSession, *, thread_id: str
) -> tuple[str | None, str, list[tuple[str, str]]]:
    """(workspace_id, project_name, 直近メッセージ) を返す。"""
    row = (
        await session.execute(
            text(
                "select p.workspace_id, p.name from public.chat_threads t "
                "join public.projects p on p.id = t.project_id "
                "where t.id = cast(:t as uuid)"
            ),
            {"t": thread_id},
        )
    ).first()
    if row is None:
        return None, "", []
    msgs = (
        await session.execute(
            text(
                "select role, content from public.chat_messages "
                "where thread_id = cast(:t as uuid) and deleted_at is null "
                "order by created_at desc limit :n"
            ),
            {"t": thread_id, "n": MAX_MESSAGES},
        )
    ).all()
    lines = [(str(m.role), str(m.content)) for m in reversed(msgs)]
    return str(row.workspace_id), str(row.name), lines


async def _existing_titles(session: AsyncSession, *, workspace_id: str) -> set[str]:
    rows = (
        await session.execute(
            text(
                "select title from public.knowledge_nodes "
                "where account_type = 'workspace' and account_id = cast(:w as uuid) "
                "and deleted_at is null"
            ),
            {"w": workspace_id},
        )
    ).all()
    return {str(r.title).strip() for r in rows}


async def capture_from_thread(
    session: AsyncSession,
    *,
    thread_id: str,
    actor_id: str,
    complete: Any = None,
) -> list[str]:
    """会話からノウハウを抽出してワークスペースのナレッジに残す。

    返り値 = 作成した knowledge の id 一覧 (何も作らなければ空)。
    complete は llm_complete 互換の注入口 (テスト用)。
    """
    workspace_id, project_name, lines = await _thread_context(session, thread_id=thread_id)
    if workspace_id is None or len(lines) < MIN_MESSAGES:
        return []

    convo = "\n".join(f"{'ユーザー' if r == 'user' else 'AI'}: {c[:600]}" for r, c in lines)
    user_text = f"案件の種類: {project_name[:40]}\n\n会話ログ:\n{convo}"

    if complete is None:
        from src.services.chat_sse.llm_chain import llm_complete as _complete

        complete = _complete
    try:
        raw, _provider = await complete(
            system_prompt=_SYSTEM,
            user_text=user_text,
            actor_id=actor_id,
            max_tokens=1200,
            fake=lambda: "[]",
        )
    except Exception as exc:
        # 実行経路が無い / 失敗しても会話は止めない (ナレッジは次回に回る)
        logger.info("knowledge auto-capture skipped (thread=%s): %s", thread_id, exc)
        return []

    candidates = parse_candidates(raw)
    if not candidates:
        return []
    existing = await _existing_titles(session, workspace_id=workspace_id)
    created: list[str] = []
    for cand in candidates:
        if cand["title"] in existing:
            continue
        row = (
            await session.execute(
                text(
                    "insert into public.knowledge_nodes "
                    "(account_id, account_type, scope, category, tags, title, content_md, "
                    " source_type, confidence_score) "
                    "values (cast(:w as uuid), 'workspace', 'common', :cat, :tags, :title, "
                    "        :body, 'ai_extracted', 0.5) returning id"
                ),
                {
                    "w": workspace_id,
                    "cat": cand["category"],
                    "tags": cand["tags"],
                    "title": cand["title"],
                    "body": cand["content_md"],
                },
            )
        ).first()
        if row is not None:
            created.append(str(row.id))
            existing.add(cand["title"])
    return created


def schedule_capture(*, thread_id: str, actor_id: str) -> None:
    """応答完了後の fire-and-forget 抽出 (失敗はログのみ — 会話を止めない)。"""
    import asyncio

    from src.services.chat_sse.summary import (
        _background_tasks,  # pyright: ignore[reportPrivateUsage]
    )

    async def _run() -> None:
        from src.services.project_credentials import (
            _service_session_factory,  # pyright: ignore[reportPrivateUsage]
        )

        try:
            async with _service_session_factory()() as session:
                created = await capture_from_thread(session, thread_id=thread_id, actor_id=actor_id)
                if created:
                    await session.commit()
                    logger.info(
                        "knowledge auto-capture: %d item(s) from thread %s",
                        len(created),
                        thread_id,
                    )
        except Exception as exc:
            logger.warning("knowledge auto-capture failed (thread=%s): %s", thread_id, exc)

    task = asyncio.create_task(_run())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
