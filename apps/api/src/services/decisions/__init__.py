"""確定事項/未確認 (decisions) サービス層 (T-D-101)。

RLS が効く AsyncSession を受け取り decisions を読み書きする。
可視性は RLS (project_id → workspace_scoped、workflow_outputs と同型)。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.decisions import DecisionCreate, DecisionResponse, DecisionUpdate

_COLS = (
    "id, project_id, phase_id, status, body, reflected_to, resolve_note, "
    "decided_by, with_user, created_at, updated_at, deleted_at"
)


def _row_to_response(row: Any) -> DecisionResponse:
    return DecisionResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        phase_id=(None if row.phase_id is None else str(row.phase_id)),
        status=str(row.status),  # type: ignore[arg-type]
        body=str(row.body),
        reflected_to=(None if row.reflected_to is None else str(row.reflected_to)),
        resolve_note=(None if row.resolve_note is None else str(row.resolve_note)),
        decided_by=(None if row.decided_by is None else str(row.decided_by)),
        with_user=bool(row.with_user),
        created_at=row.created_at,
        updated_at=row.updated_at,
        deleted_at=row.deleted_at,
    )


async def list_decisions(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    phase_id: str | None = None,
    status: str | None = None,
) -> list[DecisionResponse]:
    where = ["deleted_at is null"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if phase_id is not None:
        where.append("phase_id = cast(:phid as uuid)")
        params["phid"] = phase_id
    if status is not None:
        where.append("status = cast(:st as decision_status_enum)")
        params["st"] = status
    res = await session.execute(
        text(
            f"select {_COLS} from public.decisions "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_decision(session: AsyncSession, decision_id: str) -> DecisionResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.decisions "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": decision_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_decision(
    session: AsyncSession, *, data: DecisionCreate
) -> DecisionResponse | None:
    try:
        res = await _insert_decision(session, data)
    except (DBAPIError, ProgrammingError):
        # RLS with check 違反 (越境 insert) は権限なしとして扱う
        await session.rollback()
        return None
    row = res.first()
    await session.commit()
    return None if row is None else _row_to_response(row)


async def _insert_decision(session: AsyncSession, data: DecisionCreate):  # type: ignore[no-untyped-def]
    return await session.execute(
        text(
            "insert into public.decisions "
            "(project_id, phase_id, status, body, reflected_to, resolve_note, decided_by, with_user) "
            "values (cast(:pid as uuid), cast(:phid as uuid), cast(:st as decision_status_enum), "
            ":body, :refl, :note, cast(:emp as uuid), :wu) "
            f"returning {_COLS}"
        ),
        {
            "pid": data.project_id,
            "phid": data.phase_id,
            "st": data.status,
            "body": data.body,
            "refl": data.reflected_to,
            "note": data.resolve_note,
            "emp": data.decided_by,
            "wu": data.with_user,
        },
    )


async def update_decision(
    session: AsyncSession, *, decision_id: str, data: DecisionUpdate
) -> DecisionResponse | None:
    sets = ["updated_at = now()"]
    params: dict[str, object] = {"id": decision_id}
    if data.status is not None:
        sets.append("status = cast(:st as decision_status_enum)")
        params["st"] = data.status
    if data.body is not None:
        sets.append("body = :body")
        params["body"] = data.body
    if data.reflected_to is not None:
        sets.append("reflected_to = :refl")
        params["refl"] = data.reflected_to
    if data.resolve_note is not None:
        sets.append("resolve_note = :note")
        params["note"] = data.resolve_note
    res = await session.execute(
        text(
            f"update public.decisions set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null "
            f"returning {_COLS}"
        ),
        params,
    )
    row = res.first()
    await session.commit()
    return None if row is None else _row_to_response(row)
