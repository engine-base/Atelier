"""GAP-179: cron の実行結果をプロジェクトの会話へ届ける共通処理。

日次ダイジェスト (T-A-53) が持っていた thread 解決/投稿ロジックを、他の
自動実行 (週次バーンダウン / 進捗レポート等) からも使えるように切り出した。
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


async def find_or_create_thread(
    session: AsyncSession, *, project_id: str, title: str
) -> str | None:
    """指定タイトルの thread を返す (無ければ作る)。

    chat_threads.ai_employee_id は NOT NULL のため、workspace に AI 社員が
    1 人もいない場合は作成できず None を返す (呼び出し側は skip する)。
    """
    row = (
        await session.execute(
            text(
                "select id from public.chat_threads "
                "where project_id = cast(:p as uuid) and title = :t and archived = false "
                "order by created_at limit 1"
            ),
            {"p": project_id, "t": title},
        )
    ).first()
    if row is not None:
        return str(row.id)
    emp = (
        await session.execute(
            text(
                "select e.id from public.ai_employees e "
                "join public.projects p on p.workspace_id = e.workspace_id "
                "where p.id = cast(:p as uuid) "
                "order by e.created_at limit 1"
            ),
            {"p": project_id},
        )
    ).first()
    if emp is None:
        logger.warning("cron output skip: no ai_employee in workspace (project=%s)", project_id)
        return None
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.chat_threads (id, project_id, ai_employee_id, title) "
            "values (cast(:i as uuid), cast(:p as uuid), cast(:e as uuid), :t)"
        ),
        {"i": new_id, "p": project_id, "e": str(emp.id), "t": title},
    )
    return new_id


async def post_assistant_message(session: AsyncSession, *, thread_id: str, body: str) -> str:
    """assistant message として投稿し、message id を返す。"""
    msg_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.chat_messages (id, thread_id, role, content) "
            "values (cast(:i as uuid), cast(:t as uuid), "
            "cast('assistant' as chat_message_role_enum), :c)"
        ),
        {"i": msg_id, "t": thread_id, "c": body},
    )
    return msg_id


async def has_assistant_message_today(session: AsyncSession, *, thread_id: str) -> bool:
    """当日 (JST) の assistant message が既にあるか (日次ジョブの冪等判定)。"""
    row = (
        await session.execute(
            text(
                "select 1 from public.chat_messages "
                "where thread_id = cast(:t as uuid) and role = 'assistant' "
                "and (created_at at time zone 'Asia/Tokyo')::date = "
                "(now() at time zone 'Asia/Tokyo')::date limit 1"
            ),
            {"t": thread_id},
        )
    ).first()
    return row is not None


async def has_assistant_message_within_hours(
    session: AsyncSession, *, thread_id: str, hours: int
) -> bool:
    """直近 N 時間に assistant message があるか (週次ジョブの冪等判定)。"""
    row = (
        await session.execute(
            text(
                "select 1 from public.chat_messages "
                "where thread_id = cast(:t as uuid) and role = 'assistant' "
                "and created_at > now() - make_interval(hours => :h) limit 1"
            ),
            {"t": thread_id, "h": hours},
        )
    ).first()
    return row is not None


async def project_owner_actor_id(session: AsyncSession, *, project_id: str) -> str | None:
    """project が属する workspace の owner の user_id を返す。

    無人実行の cron が「誰の権限・誰の Claude プラン枠で動くか」を明示するための
    解決口。owner が居なければ最初の member、それも無ければ None。
    """
    row = (
        await session.execute(
            text(
                "select m.user_id from public.workspace_memberships m "
                "join public.projects p on p.workspace_id = m.workspace_id "
                "where p.id = cast(:p as uuid) "
                "order by (m.role <> 'owner'), m.joined_at limit 1"
            ),
            {"p": project_id},
        )
    ).first()
    return None if row is None else str(row.user_id)


async def project_workspace_id(session: AsyncSession, *, project_id: str) -> str | None:
    row = (
        await session.execute(
            text("select workspace_id from public.projects where id = cast(:p as uuid)"),
            {"p": project_id},
        )
    ).first()
    return None if row is None else str(row.workspace_id)


__all__ = [
    "find_or_create_thread",
    "has_assistant_message_today",
    "has_assistant_message_within_hours",
    "post_assistant_message",
    "project_owner_actor_id",
    "project_workspace_id",
]
