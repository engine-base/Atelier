"""Chat スレッド CRUD サービス層 (T-A-16)。

RLS が効く AsyncSession を受け取り chat_threads を操作する。可視性/権限は RLS (T-D-17)。
状態変更で audit_logs 記録。
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.chat import ThreadCreate, ThreadResponse, ThreadUpdate

_COLS = "id, project_id, ai_employee_id, title, archived, created_at, updated_at, deleted_at"


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
            f"select {_COLS} from public.chat_threads where {' and '.join(where)} order by created_at desc"
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
