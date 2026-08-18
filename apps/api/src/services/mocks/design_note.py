"""GAP-143: デザインノート — Open Design の DESIGN.md 相当。

「このプロジェクトのデザインの好みノート」を projects.settings.design_note に
持ち、ワンダ (design 部門 AI 社員) の**全生成・改訂**に自動注入する。
さらに改訂/生成の指示からデザイン決定 (色/フォント/トーン/レイアウト) を
抽出してノートへ自動追記する — 使うほどプロジェクトのテイストが揃っていく。

チャット側で確立済みの「AI 社員ごとの装着スキル注入」(_load_persona_and_skills)
をモック生成側にも適用し、「誰に (design 部門の社員)・いつ (全生成/改訂で)
どのスキルを読ませるか」を自動化する。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

logger = logging.getLogger(__name__)

DESIGN_NOTE_MAX_CHARS = 2000

_UPDATER_SYSTEM = (
    "あなたはデザインノートの管理者です。既存のノートと新しい指示を読み、"
    "指示に含まれる恒久的なデザイン決定 (ブランドカラー・フォント・余白・角丸・"
    "トーン・レイアウト方針など) だけを既存ノートに統合した新しいノートを出力"
    "してください。一時的な内容 (誤字修正・特定要素の文言変更など) は含めない。"
    f"{DESIGN_NOTE_MAX_CHARS} 文字以内。箇条書き。前置き・後書きは不要。"
    "恒久的な決定が何も無ければ既存ノートをそのまま出力すること。"
)


async def get_design_note(session: AsyncSession, *, project_id: str) -> str:
    """プロジェクトのデザインノート (無ければ空文字)。"""
    row = (
        await session.execute(
            text(
                "select settings ->> 'design_note' as note from public.projects "
                "where id = cast(:p as uuid)"
            ),
            {"p": project_id},
        )
    ).first()
    return "" if row is None or row.note is None else str(row.note)


async def set_design_note(
    session: AsyncSession, *, actor_id: str, project_id: str, note: str
) -> bool:
    """デザインノートを保存する (RLS 可視でなければ False)。"""
    res = await session.execute(
        text(
            "update public.projects set "
            "settings = jsonb_set(settings, '{design_note}', to_jsonb(cast(:n as text))), "
            "updated_at = now() "
            "where id = cast(:p as uuid) returning id"
        ),
        {"n": note[:DESIGN_NOTE_MAX_CHARS], "p": project_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="project.design_note.update",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"chars": len(note)},
        )
    )
    return True


async def build_design_context(session: AsyncSession, *, project_id: str) -> str:
    """ワンダの生成/改訂 system prompt へ前置する文脈ブロックを組み立てる。

    - デザインノート (必ず従う制約として)
    - design 部門 AI 社員 (= ワンダ) のペルソナ + 装着スキル (チャットと同一機構)
    どちらも無ければ空文字 (従来どおりの素の生成)。
    """
    parts: list[str] = []
    note = await get_design_note(session, project_id=project_id)
    if note.strip() != "":
        parts.append("# このプロジェクトのデザインノート (必ず従うこと)\n" + note.strip())
    designer = (
        await session.execute(
            text(
                "select e.id from public.ai_employees e "
                "join public.projects p on p.workspace_id = e.workspace_id "
                "where p.id = cast(:p as uuid) and e.department = 'design' "
                "and e.archived = false order by e.is_default desc, e.created_at limit 1"
            ),
            {"p": project_id},
        )
    ).first()
    if designer is not None:
        from src.services.chat_sse import (
            _load_persona_and_skills,  # pyright: ignore[reportPrivateUsage]
        )

        persona, skills_md = await _load_persona_and_skills(
            session, ai_employee_id=str(designer.id)
        )
        if persona.strip() != "":
            parts.append("# デザイナーのペルソナ\n" + persona)
        for md in skills_md:
            parts.append(md)
    return "\n\n".join(parts)


async def apply_design_note_learning(*, project_id: str, instruction: str, actor_id: str) -> bool:
    """指示から恒久的なデザイン決定を抽出してノートへ統合する (service 経路)。

    LLM は llm_chain (relay=本人サブスク優先)。actor_id は指示を出した本人 —
    relay ジョブの requested_by (= 本人の Bridge が本人のサブスクで実行) になる。
    失敗・空・過大は保存しない (ノートは壊さない)。応答経路とは独立の best-effort。
    """
    from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete

    from .artifacts import service_session_factory

    factory = service_session_factory()
    async with factory() as session:
        current = await get_design_note(session, project_id=project_id)
    prompt = (
        f"既存のデザインノート:\n{current if current else '(まだ無い)'}\n\n"
        f"新しい指示:\n{instruction[:2000]}\n\n"
        "統合した新しいノート:"
    )
    try:
        out, _provider = await llm_complete(
            system_prompt=_UPDATER_SYSTEM,
            user_text=prompt,
            actor_id=actor_id,
            max_tokens=1200,
            fake=lambda: (current + "\n- " + instruction[:120]).strip(),
        )
    except LLMUnavailable:
        return False
    except Exception as exc:  # pragma: no cover - 実 LLM 障害
        logger.warning("design note learning failed (project=%s): %s", project_id, exc)
        return False
    new_note = out.strip()
    if new_note == "" or len(new_note) > DESIGN_NOTE_MAX_CHARS * 2:
        return False
    if new_note == current.strip():
        return False  # 変化なし (恒久的決定が無かった)
    async with factory() as session:
        await session.execute(
            text(
                "update public.projects set "
                "settings = jsonb_set(settings, '{design_note}', to_jsonb(cast(:n as text)))"
                " where id = cast(:p as uuid)"
            ),
            {"n": new_note[:DESIGN_NOTE_MAX_CHARS], "p": project_id},
        )
        await session.commit()
    return True


_background_tasks: set[Any] = set()


def schedule_design_note_learning(*, project_id: str, instruction: str, actor_id: str) -> None:
    """生成/改訂の応答を待たせない fire-and-forget 学習 (失敗はログのみ)。"""
    import asyncio

    async def _run() -> None:
        try:
            await apply_design_note_learning(
                project_id=project_id, instruction=instruction, actor_id=actor_id
            )
        except Exception as exc:  # ノート学習の失敗は本体を壊さない
            logger.warning("design note learning task failed (project=%s): %s", project_id, exc)

    task = asyncio.create_task(_run())
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
