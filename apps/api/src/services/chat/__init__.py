"""Chat スレッド CRUD サービス層 (T-A-16)。

RLS が効く AsyncSession を受け取り chat_threads を操作する。可視性/権限は RLS (T-D-17)。
状態変更で audit_logs 記録。
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.chat import (
    MessageCreate,
    MessageFeedbackCreate,
    MessageFeedbackResponse,
    MessageResponse,
    ThreadCreate,
    ThreadResponse,
    ThreadUpdate,
)

_COLS = "id, project_id, ai_employee_id, title, archived, created_at, updated_at, deleted_at"

_MSG_COLS = "id, thread_id, role, content, parent_message_id, token_count, created_at, updated_at"


def _msg_to_response(row: Any) -> MessageResponse:
    return MessageResponse(
        id=str(row.id),
        thread_id=str(row.thread_id),
        role=str(row.role),
        content=str(row.content),
        parent_message_id=(None if row.parent_message_id is None else str(row.parent_message_id)),
        token_count=(None if row.token_count is None else int(row.token_count)),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _row_to_response(row: Any) -> ThreadResponse:
    return ThreadResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        ai_employee_id=str(row.ai_employee_id),
        title=(None if row.title is None else str(row.title)),
        archived=bool(row.archived),
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
        message_count=int(getattr(row, "message_count", 0) or 0),
    )


async def list_threads(
    session: AsyncSession, *, project_id: str | None = None, include_archived: bool = False
) -> list[ThreadResponse]:
    where = ["deleted_at is null"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if not include_archived:
        where.append("archived = false")
    res = await session.execute(
        text(
            f"select {_COLS}, "
            "(select count(*) from public.chat_messages m "
            " where m.thread_id = chat_threads.id and m.deleted_at is null) as message_count "
            f"from public.chat_threads where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_thread(session: AsyncSession, thread_id: str) -> ThreadResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.chat_threads where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": thread_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_thread(
    session: AsyncSession, *, actor_id: str, data: ThreadCreate
) -> ThreadResponse:
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.chat_threads (id, project_id, ai_employee_id, title) "
            "values (cast(:id as uuid), cast(:pid as uuid), cast(:eid as uuid), :title)"
        ),
        {"id": new_id, "pid": data.project_id, "eid": data.ai_employee_id, "title": data.title},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat_thread.create",
            target_type="chat_thread",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"project_id": data.project_id, "ai_employee_id": data.ai_employee_id},
        )
    )
    created = await get_thread(session, new_id)
    if created is None:  # pragma: no cover
        raise RuntimeError("created thread not visible after insert")
    return created


async def update_thread(
    session: AsyncSession, *, actor_id: str, thread_id: str, data: ThreadUpdate
) -> ThreadResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": thread_id}
    if data.title is not None:
        sets.append("title = :title")
        params["title"] = data.title
    if data.archived is not None:
        sets.append("archived = :arch")
        params["arch"] = data.archived
    if not sets:
        return await get_thread(session, thread_id)
    res = await session.execute(
        text(
            f"update public.chat_threads set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="chat_thread.update",
            target_type="chat_thread",
            actor_type="user",
            actor_id=actor_id,
            target_id=thread_id,
        )
    )
    return await get_thread(session, thread_id)


async def delete_thread(session: AsyncSession, *, actor_id: str, thread_id: str) -> bool:
    res = await session.execute(
        text(
            "update public.chat_threads set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": thread_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="chat_thread.delete",
            target_type="chat_thread",
            actor_type="user",
            actor_id=actor_id,
            target_id=thread_id,
        )
    )
    return True


async def list_messages(session: AsyncSession, *, thread_id: str) -> list[MessageResponse]:
    """スレッド内メッセージを古い順に。可視性は RLS (chat_messages_select_member)。"""
    res = await session.execute(
        text(
            f"select {_MSG_COLS} from public.chat_messages "
            "where thread_id = cast(:tid as uuid) and deleted_at is null "
            "order by created_at, id"
        ),
        {"tid": thread_id},
    )
    return [_msg_to_response(r) for r in res.all()]


async def can_post_to_thread(session: AsyncSession, *, thread_id: str) -> bool:
    """ログインユーザーが当該スレッドに投稿可能 (owner/member) か。

    viewer ロールは閲覧のみで投稿不可。RLS insert ポリシーと同条件を事前判定し、
    403 を返せるようにする (RLS 違反による 500 を避ける)。
    """
    res = await session.execute(
        text(
            "select exists("
            " select 1 from public.chat_threads t "
            " join public.projects p on p.id = t.project_id "
            " join public.workspace_memberships m on m.workspace_id = p.workspace_id "
            " where t.id = cast(:tid as uuid) and m.user_id = auth.uid() "
            " and m.role in ('owner','member'))"
        ),
        {"tid": thread_id},
    )
    return bool(res.scalar_one())


async def create_message(
    session: AsyncSession, *, actor_id: str, thread_id: str, data: MessageCreate
) -> MessageResponse:
    """ユーザー発話を即時に永続化 (role='user')。AI 応答生成は T-A-18 (SSE)。

    T-A-19: parent_message_id を渡すと同スレッド内の分岐として記録する
    (chat_messages.parent_message_id)。CHECK no_self_parent + FK on delete set null
    は DB が enforce。
    """
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.chat_messages (id, thread_id, role, content, parent_message_id) "
            "values (cast(:id as uuid), cast(:tid as uuid), 'user', :content, "
            " cast(:parent as uuid))"
        ),
        {
            "id": new_id,
            "tid": thread_id,
            "content": data.content,
            "parent": data.parent_message_id,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat_message.create",
            target_type="chat_message",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={
                "thread_id": thread_id,
                "role": "user",
                "parent_message_id": data.parent_message_id,
            },
        )
    )
    res = await session.execute(
        text(f"select {_MSG_COLS} from public.chat_messages where id = cast(:id as uuid)"),
        {"id": new_id},
    )
    row = res.first()
    if row is None:  # pragma: no cover - 直前に作成済
        raise RuntimeError("created message not visible after insert")
    return _msg_to_response(row)


async def get_message_thread_id(session: AsyncSession, *, message_id: str) -> str | None:
    """message が可視 (RLS chat_messages_select_member) なら thread_id を返す。"""
    res = await session.execute(
        text(
            "select thread_id from public.chat_messages "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": message_id},
    )
    row = res.first()
    return None if row is None else str(row.thread_id)


async def create_message_feedback(
    session: AsyncSession,
    *,
    actor_id: str,
    message_id: str,
    data: MessageFeedbackCreate,
) -> MessageFeedbackResponse:
    """T-A-19: 本人 (actor=user) によるメッセージへの feedback を audit_logs に記録。

    feedback 専用テーブルが無いため append-only な audit_logs に
    action='chat_message.feedback' で記録 (audit_logs_insert_self を満たす)。
    """
    feedback_id = str(uuid.uuid4())
    recorded_at = datetime.now(tz=UTC)
    await AuditWriter(session).write(
        AuditEvent(
            action="chat_message.feedback",
            target_type="chat_message",
            actor_type="user",
            actor_id=actor_id,
            target_id=message_id,
            after={
                "feedback_id": feedback_id,
                "value": data.value,
                "comment": data.comment,
            },
            created_at=recorded_at,
        )
    )
    return MessageFeedbackResponse(
        feedback_id=feedback_id,
        message_id=message_id,
        value=data.value,
        comment=data.comment,
        recorded_at=recorded_at,
    )
