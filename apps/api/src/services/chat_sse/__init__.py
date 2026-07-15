"""チャット SSE + F-CTX01 文脈構築 サービス層 (T-A-18 / T-A-48 完全実装)。

F-CTX01 (完全版): ペルソナ + 装着スキル(content_md) + プロジェクト状態(DB-as-truth)
+ これまでの経緯(要約) + ナレッジRAG(本物の Voyage/pgvector 意味検索, 運営デフォルト
platform を横断参照) + 直近履歴 を system prompt に組み立てる。LLM 呼出は Anthropic SDK。

LLM 未接続時 (ANTHROPIC_API_KEY 未設定) は本番では **fake/stub を黙って返さず error** を
返す (鉄則: stub 排除)。テストのみ ATELIER_ALLOW_FAKE_LLM=1 で echo fallback を許可する。

state-changing 操作 (user/assistant message の chat_messages 挿入) は
audit_logs に必ず記録 (3-tier AC: state-changing audit)。
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.chat_sse import ChatContextPreviewResponse

logger = logging.getLogger(__name__)


async def _load_recent_messages(
    session: AsyncSession, *, thread_id: str, limit: int
) -> list[tuple[str, str]]:
    """thread の過去 message を (role, content) の組で新しい順 → 古い順で返す。"""
    if limit <= 0:
        return []
    res = await session.execute(
        text(
            "select role, content from public.chat_messages "
            "where thread_id = cast(:tid as uuid) "
            "order by created_at desc limit :lim"
        ),
        {"tid": thread_id, "lim": limit},
    )
    rows = list(res.all())
    rows.reverse()
    return [(str(r.role), str(r.content)) for r in rows]


async def _build_rag_context(
    session: AsyncSession, *, query: str, account_id: str | None
) -> tuple[str, list[str]]:
    """ナレッジ RAG を **本物のベクトル検索** (Voyage 埋め込み + pgvector cosine) で構築する。

    T-A-47 の knowledge.search_knowledge を呼ぶ (VOYAGE_API_KEY 未設定時は text fallback に
    自動 degrade)。account_id 指定時はそのテナント + 運営デフォルト (account_type=platform) を
    横断参照する。RLS で不可視は自動 skip。
    """
    from src.services import knowledge as kn

    result = await kn.search_knowledge(session, query=query, limit=5, account_id=account_id)
    if not result.hits:
        return "", []
    lines = ["以下は関連ナレッジ (意味検索 / RAG):"]
    ids: list[str] = []
    for hit in result.hits:
        k = hit.knowledge
        lines.append(f"- [{k.title}] {k.content_md[:300]}")
        ids.append(k.id)
    return "\n".join(lines), ids


async def _load_thread_meta(
    session: AsyncSession, *, thread_id: str
) -> tuple[str | None, str | None]:
    """thread から (ai_employee_id, project_id) を返す。RLS 不可視なら (None, None)。"""
    res = await session.execute(
        text(
            "select ai_employee_id, project_id from public.chat_threads where id = cast(:t as uuid)"
        ),
        {"t": thread_id},
    )
    row = res.first()
    if row is None:
        return None, None
    return (
        None if row.ai_employee_id is None else str(row.ai_employee_id),
        None if row.project_id is None else str(row.project_id),
    )


async def _load_persona_and_skills(
    session: AsyncSession, *, ai_employee_id: str
) -> tuple[str, list[str]]:
    """AI 社員のペルソナ文 + 装着スキル(content_md) を返す。"""
    res = await session.execute(
        text(
            "select display_name, role, department, tone_preset, custom_tone_text, "
            "system_prompt_override, attached_skills "
            "from public.ai_employees where id = cast(:i as uuid)"
        ),
        {"i": ai_employee_id},
    )
    row = res.first()
    if row is None:
        return "", []
    persona_lines: list[str] = []
    name = str(row.display_name) if row.display_name else "AI社員"
    role = str(row.role) if row.role else ""
    dept = str(row.department) if row.department else ""
    persona_lines.append(f"あなたは「{name}」（{dept} {role}）として振る舞います。")
    if row.tone_preset:
        persona_lines.append(f"口調: {row.tone_preset}")
    if row.custom_tone_text:
        persona_lines.append(str(row.custom_tone_text))
    if row.system_prompt_override:
        persona_lines.append(str(row.system_prompt_override))
    raw_skills: list[object] = list(row.attached_skills) if row.attached_skills is not None else []
    skill_ids: list[str] = [str(s) for s in raw_skills]
    skills_md: list[str] = []
    if skill_ids:
        sres = await session.execute(
            text(
                "select name, content_md from public.skills "
                "where id = any(cast(:ids as uuid[])) and is_active = true"
            ),
            {"ids": skill_ids},
        )
        for s in sres.all():
            skills_md.append(f"## スキル: {s.name}\n{s.content_md!s}")
    return "\n".join(persona_lines), skills_md


async def _load_project_state(session: AsyncSession, *, project_id: str) -> str:
    """プロジェクト状態 (DB-as-truth) を文脈テキストで返す。"""
    res = await session.execute(
        text("select name, status, project_type from public.projects where id = cast(:p as uuid)"),
        {"p": project_id},
    )
    row = res.first()
    if row is None:
        return ""
    return f"現在のプロジェクト: 「{row.name}」 (種別={row.project_type} / 状態={row.status})"


async def _fold_older_history(
    session: AsyncSession, *, thread_id: str, recent_window: int, char_budget: int = 1200
) -> str:
    """直近 recent_window より前の発言を「これまでの経緯」として畳み込む。

    threads に context_summary 列が無いため毎ターン算出 (ローリング要約の簡易版)。
    長スレッドでも古い文脈を落とさず保持する。char_budget で全体長を制限。
    """
    res = await session.execute(
        text(
            "select role, content from public.chat_messages "
            "where thread_id = cast(:t as uuid) order by created_at desc offset :off"
        ),
        {"t": thread_id, "off": recent_window},
    )
    rows = list(res.all())
    if not rows:
        return ""
    rows.reverse()
    joined = " / ".join(f"{r.role}: {str(r.content)[:120]}" for r in rows)
    if len(joined) > char_budget:
        joined = "…" + joined[-char_budget:]
    return f"これまでの経緯(要約): {joined}"


async def build_context(
    session: AsyncSession,
    *,
    thread_id: str,
    user_message: str,
    include_history: int,
    rag_account_id: str | None,
    use_rag: bool = True,
) -> tuple[str, list[tuple[str, str]], list[str]]:
    """(system_prompt, history, rag_hit_ids) を返す F-CTX01 構築。

    構成: ペルソナ + 装着スキル(content_md) + プロジェクト状態(DB-as-truth) +
    これまでの経緯(要約) + ナレッジRAG(本物ベクトル) + 直近履歴。
    """
    ai_employee_id, project_id = await _load_thread_meta(session, thread_id=thread_id)
    history = await _load_recent_messages(session, thread_id=thread_id, limit=include_history)

    base = "あなたは Atelier の AI アシスタントです。日本語で簡潔に回答してください。"
    parts: list[str] = [base]

    if ai_employee_id is not None:
        persona, skills_md = await _load_persona_and_skills(session, ai_employee_id=ai_employee_id)
        if persona:
            parts.append(persona)
        parts.extend(skills_md)

    if project_id is not None:
        proj_state = await _load_project_state(session, project_id=project_id)
        if proj_state:
            parts.append(proj_state)

    summary = await _fold_older_history(session, thread_id=thread_id, recent_window=include_history)
    if summary:
        parts.append(summary)

    rag_ids: list[str] = []
    if use_rag:
        rag_block, rag_ids = await _build_rag_context(
            session, query=user_message, account_id=rag_account_id
        )
        if rag_block:
            parts.append(rag_block)

    return "\n\n".join(parts), history, rag_ids


async def preview_context(
    session: AsyncSession,
    *,
    thread_id: str,
    user_message: str,
    include_history: int,
    rag_account_id: str | None,
) -> ChatContextPreviewResponse:
    system_prompt, history, rag_ids = await build_context(
        session,
        thread_id=thread_id,
        user_message=user_message,
        include_history=include_history,
        rag_account_id=rag_account_id,
        use_rag=True,
    )
    return ChatContextPreviewResponse(
        system_prompt=system_prompt,
        history_count=len(history),
        rag_hit_ids=rag_ids,
    )


async def _insert_message(
    session: AsyncSession,
    *,
    thread_id: str,
    role: str,
    content: str,
) -> str:
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.chat_messages "
            "(id, thread_id, role, content) "
            "values (cast(:i as uuid), cast(:t as uuid), "
            "cast(:r as chat_message_role_enum), :c)"
        ),
        {"i": new_id, "t": thread_id, "r": role, "c": content},
    )
    return new_id


def _sse_event(payload: dict[str, Any]) -> bytes:
    """data: <json>\\n\\n の SSE event をエンコード。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def _fake_stream_chunks(prompt: str) -> AsyncIterator[str]:
    """ANTHROPIC_API_KEY 不在時の fallback。

    user_message を echo する deterministic な短い応答を 1 文字ずつ
    yield する (テスト容易性 + SSE 配信パス検証用)。
    """
    fake_text = f"echo: {prompt[:200]}"
    for ch in fake_text:
        yield ch


def _build_system_param(system_prompt: str) -> str | list[dict[str, Any]]:
    """T-A-52: 実 stream の system 引数を組み立てる。

    T-F-15 の cache_system_prompt() で cache_control 付き blocks に変換し、
    連続ターンで provider prompt cache にヒットし得る形にする
    (Atelier の system はペルソナ+スキル+プロジェクト状態で毎ターンほぼ同一)。
    ATELIER_PROMPT_CACHE_DISABLED=1 で plain string のまま渡す (既定は有効)。
    """
    if os.environ.get("ATELIER_PROMPT_CACHE_DISABLED") == "1":
        return system_prompt
    from src.llm.caching import cache_system_prompt

    blocks = cache_system_prompt(system_prompt)
    return blocks if blocks else system_prompt


def _build_stream_tools() -> list[dict[str, Any]] | None:
    """T-A-51: 実 stream に注入する tools を組み立てる。

    T-F-21 の build_web_search_tool() を唯一の組立元とする (独自 dict 直書き禁止)。
    ATELIER_WEB_SEARCH_DISABLED=1 で注入を無効化できる (既定は有効)。
    """
    if os.environ.get("ATELIER_WEB_SEARCH_DISABLED") == "1":
        return None
    from src.tools.web_search import build_web_search_tool

    return [build_web_search_tool()]


async def _real_stream_chunks(
    *,
    system_prompt: str,
    history: list[tuple[str, str]],
    user_message: str,
) -> AsyncIterator[str]:
    """Anthropic SDK で実 stream。chunk text delta を yield する。

    web_search は Anthropic server-side tool のため、tool 実行は provider 側で
    完結し、text_stream は text delta のみを yield する (SSE 整形は不変)。
    """
    from anthropic import AsyncAnthropic  # type: ignore[import-not-found]

    client = AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    msgs: list[dict[str, str]] = []
    for role, content in history:
        if role in ("user", "assistant"):
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": user_message})

    kwargs: dict[str, Any] = {}
    tools = _build_stream_tools()
    if tools is not None:
        kwargs["tools"] = tools

    async with client.messages.stream(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=_build_system_param(system_prompt),  # type: ignore[arg-type]
        messages=msgs,  # type: ignore[arg-type]
        **kwargs,
    ) as stream:
        async for delta in stream.text_stream:  # type: ignore[union-attr]
            if delta:
                yield delta


async def stream_chat(
    session: AsyncSession,
    *,
    actor_id: str,
    thread_id: str,
    user_message: str,
    use_rag: bool,
    include_history: int,
    rag_account_id: str | None,
) -> AsyncIterator[bytes]:
    """SSE byte stream を yield する generator。

    1. F-CTX01: system prompt + history + RAG を構築
    2. chat_messages に user message を insert (audit)
    3. LLM stream → SSE 'delta' を chunk 配信
    4. 完了時に assistant message を chat_messages に insert (audit)
    5. 'end' event で usage / message_ids を返す
    """
    system_prompt, history, rag_ids = await build_context(
        session,
        thread_id=thread_id,
        user_message=user_message,
        include_history=include_history,
        rag_account_id=rag_account_id,
        use_rag=use_rag,
    )

    user_msg_id = await _insert_message(
        session, thread_id=thread_id, role="user", content=user_message
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat.message.create",
            target_type="chat_message",
            actor_type="user",
            actor_id=actor_id,
            target_id=user_msg_id,
            after={"thread_id": thread_id, "role": "user"},
        )
    )

    yield _sse_event(
        {
            "type": "context",
            "metadata": {
                "history_count": len(history),
                "rag_hit_ids": rag_ids,
                "user_message_id": user_msg_id,
            },
        }
    )
    yield _sse_event({"type": "start"})

    use_real = bool(os.environ.get("ANTHROPIC_API_KEY"))
    allow_fake = os.environ.get("ATELIER_ALLOW_FAKE_LLM") == "1"
    if not use_real and not allow_fake:
        # 本番では LLM 未接続時に fake/stub を黙って返さない (F-CTX01 / 鉄則: stub 排除)。
        yield _sse_event(
            {
                "type": "error",
                "content": "LLM が利用できません (ANTHROPIC_API_KEY 未設定)。",
            }
        )
        return
    accumulated: list[str] = []
    try:
        if use_real:
            chunks = _real_stream_chunks(
                system_prompt=system_prompt,
                history=history,
                user_message=user_message,
            )
        else:
            chunks = _fake_stream_chunks(user_message)
        async for chunk in chunks:
            accumulated.append(chunk)
            yield _sse_event({"type": "delta", "content": chunk})
    except Exception as exc:  # pragma: no cover  - 実 LLM 障害は別レイヤ
        # 生のプロバイダーエラー (request_id 等の内部情報) はクライアントへ流さない。
        logger.error("chat stream LLM failure (thread=%s): %s", thread_id, exc)
        yield _sse_event(
            {
                "type": "error",
                "content": "AI 応答の取得に失敗しました。時間をおいて再試行してください。",
            }
        )
        return

    final_text = "".join(accumulated)
    assistant_msg_id = await _insert_message(
        session, thread_id=thread_id, role="assistant", content=final_text
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat.message.create",
            target_type="chat_message",
            actor_type="user",
            actor_id=actor_id,
            target_id=assistant_msg_id,
            after={"thread_id": thread_id, "role": "assistant"},
        )
    )

    yield _sse_event(
        {
            "type": "end",
            "metadata": {
                "assistant_message_id": assistant_msg_id,
                "user_message_id": user_msg_id,
                "total_chars": len(final_text),
            },
        }
    )
