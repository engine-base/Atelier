"""Project CRUD サービス層 (T-A-10)。

RLS が効く AsyncSession (get_rls_session) を受け取り projects を操作する。
可視性/権限は RLS policy (T-D-15) で enforce、状態変更で audit_logs 記録。

契約 ↔ DB の enum / 列名差異を本層で吸収する:
  type   : self_product↔internal_product / client_project↔client_work / personal
  status : in_progress↔active / draft / paused / archived
  ai_learning_opt_out (契約) ↔ ai_training_optout (DB 列)
  description は DB 列が無いため settings JSONB に格納
"""

from __future__ import annotations

import base64
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.projects import (
    PaginationMeta,
    ProjectCreate,
    ProjectResponse,
    ProjectStatus,
    ProjectType,
    ProjectUpdate,
)

_TYPE_TO_DB: dict[str, str] = {
    "self_product": "internal_product",
    "client_project": "client_work",
    "personal": "personal",
}
_TYPE_TO_API: dict[str, ProjectType] = {
    "internal_product": "self_product",
    "client_work": "client_project",
    "personal": "personal",
}
_STATUS_TO_DB: dict[str, str] = {
    "in_progress": "active",
    "draft": "draft",
    "paused": "paused",
    "archived": "archived",
}
_STATUS_TO_API: dict[str, ProjectStatus] = {
    "active": "in_progress",
    "draft": "draft",
    "paused": "paused",
    "archived": "archived",
}

_VALID_PHASES = {
    "hearing",
    "requirements",
    "architecture",
    "design",
    "breakdown",
    "tasks",
    "implementation",
    "verification",
    "delivery",
}

_SELECT_COLS = (
    "p.id, p.workspace_id, p.name, p.project_type, p.status, p.ai_training_optout, "
    "p.settings ->> 'description' AS description, "
    "p.created_at, p.updated_at, p.deleted_at, "
    "coalesce("
    "  (select ph.name from public.phases ph where ph.project_id = p.id "
    "     and ph.status = 'in_progress' order by ph.\"order\" limit 1), "
    "  'hearing') AS current_phase"
)


def _row_to_response(row: Any) -> ProjectResponse:
    phase = str(row.current_phase)
    return ProjectResponse(
        id=str(row.id),
        workspace_id=str(row.workspace_id),
        name=str(row.name),
        description=(None if row.description is None else str(row.description)),
        type=_TYPE_TO_API.get(str(row.project_type), "personal"),
        status=_STATUS_TO_API.get(str(row.status), "draft"),
        ai_learning_opt_out=bool(row.ai_training_optout),
        current_phase=phase if phase in _VALID_PHASES else "hearing",
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _encode_cursor(created_at: object, pid: str) -> str:
    raw = f"{created_at}|{pid}".encode()
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[str, str]:
    raw = base64.urlsafe_b64decode(cursor.encode()).decode()
    ts, pid = raw.split("|", 1)
    return ts, pid


async def list_projects(
    session: AsyncSession,
    *,
    workspace_id: str | None = None,
    status: str | None = None,
    cursor: str | None = None,
    limit: int = 20,
) -> tuple[list[ProjectResponse], PaginationMeta]:
    """RLS 可視な project 一覧 (keyset cursor: created_at, id 昇順)。"""
    limit = max(1, min(limit, 100))
    params: dict[str, object] = {"lim": limit + 1}
    where = ["p.deleted_at is null"]
    if workspace_id is not None:
        where.append("p.workspace_id = cast(:wid as uuid)")
        params["wid"] = workspace_id
    if status is not None and status in _STATUS_TO_DB:
        where.append("p.status = :st")
        params["st"] = _STATUS_TO_DB[status]
    if cursor is not None:
        ts, pid = _decode_cursor(cursor)
        where.append("(p.created_at, p.id) > (cast(:cts as timestamptz), cast(:cid as uuid))")
        params["cts"] = ts
        params["cid"] = pid

    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.projects p "
            f"where {' and '.join(where)} order by p.created_at, p.id limit :lim"
        ),
        params,
    )
    rows = res.all()
    has_more = len(rows) > limit
    page = rows[:limit]
    items = [_row_to_response(r) for r in page]
    next_cursor = _encode_cursor(page[-1].created_at, page[-1].id) if has_more and page else None

    count_where = ["p.deleted_at is null"]
    count_params: dict[str, object] = {}
    if workspace_id is not None:
        count_where.append("p.workspace_id = cast(:wid as uuid)")
        count_params["wid"] = workspace_id
    total = await session.execute(
        text(f"select count(*) from public.projects p where {' and '.join(count_where)}"),
        count_params,
    )
    meta = PaginationMeta(
        next_cursor=next_cursor, limit=limit, total_estimate=int(total.scalar_one())
    )
    return items, meta


async def get_project(session: AsyncSession, project_id: str) -> ProjectResponse | None:
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.projects p "
            "where p.id = cast(:id as uuid) and p.deleted_at is null"
        ),
        {"id": project_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_project(
    session: AsyncSession, *, actor_id: str, data: ProjectCreate
) -> ProjectResponse:
    # workspace member は作成時点で既に可視なので RETURNING でも問題ないが、
    # workspaces (T-A-06) と同じく client 生成 id + RETURNING 無しで統一する。
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.projects (id, workspace_id, name, project_type, settings) "
            "values (cast(:id as uuid), cast(:wid as uuid), :name, "
            "        cast(:ptype as project_type_enum), "
            "        jsonb_build_object('description', cast(:desc as text)))"
        ),
        {
            "id": new_id,
            "wid": data.workspace_id,
            "name": data.name,
            "ptype": _TYPE_TO_DB[data.type],
            "desc": data.description,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="project.create",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=data.workspace_id,
            target_id=new_id,
            after={"name": data.name, "type": data.type},
        )
    )
    created = await get_project(session, new_id)
    if created is None:  # pragma: no cover - 直前に作成済
        raise RuntimeError("created project not visible after insert")
    return created


async def update_project(
    session: AsyncSession, *, actor_id: str, project_id: str, data: ProjectUpdate
) -> ProjectResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": project_id}
    if data.name is not None:
        sets.append("name = :name")
        params["name"] = data.name
    if data.status is not None:
        sets.append("status = cast(:st as project_status_enum)")
        params["st"] = _STATUS_TO_DB[data.status]
    if data.description is not None:
        sets.append(
            "settings = jsonb_set(settings, '{description}', to_jsonb(cast(:desc as text)))"
        )
        params["desc"] = data.description
    if not sets:
        return await get_project(session, project_id)

    res = await session.execute(
        text(
            f"update public.projects set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="project.update",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={k: v for k, v in params.items() if k != "id"},
        )
    )
    return await get_project(session, project_id)


async def delete_project(session: AsyncSession, *, actor_id: str, project_id: str) -> bool:
    """ソフト削除 (deleted_at)。1 行更新で True。"""
    res = await session.execute(
        text(
            "update public.projects set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": project_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="project.delete",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
        )
    )
    return True
