"""商談ドキュメント (sales_docs) サービス層 (T-A-39)。

RLS が効く AsyncSession を受け取り workflow_outputs を stage in
('proposal', 'estimate') でフィルタする。可視性/権限は RLS (T-D-21)。
状態変更 (create / update / delete) は audit_logs に必ず記録。

version は project_id + stage ごとに max(version)+1 で自動採番する。
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.sales_docs import (
    SalesDocCreate,
    SalesDocResponse,
    SalesDocType,
    SalesDocUpdate,
)

_SALES_STAGES: tuple[str, ...] = ("proposal", "estimate")

_COLS = (
    "id, project_id, phase_id, stage, html_path, json_path, md_path, "
    "summary, version, created_at, updated_at, deleted_at"
)


def _row_to_response(row: Any) -> SalesDocResponse:
    return SalesDocResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        phase_id=(None if row.phase_id is None else str(row.phase_id)),
        doc_type=str(row.stage),  # type: ignore[arg-type]
        html_path=(None if row.html_path is None else str(row.html_path)),
        json_path=(None if row.json_path is None else str(row.json_path)),
        md_path=(None if row.md_path is None else str(row.md_path)),
        summary=(None if row.summary is None else str(row.summary)),
        version=int(row.version),
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_sales_docs(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    doc_type: SalesDocType | None = None,
) -> list[SalesDocResponse]:
    where = ["deleted_at is null", "stage = any(:stages)"]
    params: dict[str, object] = {"stages": list(_SALES_STAGES)}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if doc_type is not None:
        where.append("stage = cast(:st as workflow_stage_enum)")
        params["st"] = doc_type
    res = await session.execute(
        text(
            f"select {_COLS} from public.workflow_outputs "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_sales_doc(session: AsyncSession, doc_id: str) -> SalesDocResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.workflow_outputs "
            "where id = cast(:id as uuid) and deleted_at is null "
            "and stage = any(:stages)"
        ),
        {"id": doc_id, "stages": list(_SALES_STAGES)},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def _next_version(session: AsyncSession, *, project_id: str, doc_type: str) -> int:
    res = await session.execute(
        text(
            "select coalesce(max(version), 0) + 1 from public.workflow_outputs "
            "where project_id = cast(:pid as uuid) and stage = cast(:st as workflow_stage_enum)"
        ),
        {"pid": project_id, "st": doc_type},
    )
    return int(res.scalar_one())


async def create_sales_doc(
    session: AsyncSession, *, actor_id: str, data: SalesDocCreate
) -> SalesDocResponse | None:
    new_id = str(uuid.uuid4())
    version = await _next_version(session, project_id=data.project_id, doc_type=data.doc_type)
    res = await session.execute(
        text(
            "insert into public.workflow_outputs "
            "(id, project_id, stage, html_path, json_path, md_path, summary, version) "
            "values (cast(:id as uuid), cast(:pid as uuid), "
            "cast(:st as workflow_stage_enum), :hp, :jp, :mp, :sm, :ver) "
            "returning id"
        ),
        {
            "id": new_id,
            "pid": data.project_id,
            "st": data.doc_type,
            "hp": data.html_path,
            "jp": data.json_path,
            "mp": data.md_path,
            "sm": data.summary,
            "ver": version,
        },
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="sales_doc.create",
            target_type="workflow_output",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={
                "project_id": data.project_id,
                "doc_type": data.doc_type,
                "version": version,
            },
        )
    )
    return await get_sales_doc(session, new_id)


async def update_sales_doc(
    session: AsyncSession, *, actor_id: str, doc_id: str, data: SalesDocUpdate
) -> SalesDocResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": doc_id, "stages": list(_SALES_STAGES)}
    if data.summary is not None:
        sets.append("summary = :sm")
        params["sm"] = data.summary
    if data.html_path is not None:
        sets.append("html_path = :hp")
        params["hp"] = data.html_path
    if data.json_path is not None:
        sets.append("json_path = :jp")
        params["jp"] = data.json_path
    if data.md_path is not None:
        sets.append("md_path = :mp")
        params["mp"] = data.md_path
    if not sets:
        return await get_sales_doc(session, doc_id)
    sets.append("updated_at = now()")
    res = await session.execute(
        text(
            f"update public.workflow_outputs set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null "
            "and stage = any(:stages) returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="sales_doc.update",
            target_type="workflow_output",
            actor_type="user",
            actor_id=actor_id,
            target_id=doc_id,
            after={k: v for k, v in params.items() if k not in {"id", "stages"}},
        )
    )
    return await get_sales_doc(session, doc_id)


async def delete_sales_doc(session: AsyncSession, *, actor_id: str, doc_id: str) -> bool:
    res = await session.execute(
        text(
            "update public.workflow_outputs set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null "
            "and stage = any(:stages) returning id"
        ),
        {"id": doc_id, "stages": list(_SALES_STAGES)},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="sales_doc.delete",
            target_type="workflow_output",
            actor_type="user",
            actor_id=actor_id,
            target_id=doc_id,
        )
    )
    return True
