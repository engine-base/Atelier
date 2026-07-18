"""工程ワークフロー (phases) サービス層 (T-A-20)。

RLS が効く AsyncSession を受け取り phases を操作する。可視性/権限は RLS (T-D-21)。
status 遷移時に started_at / completed_at を自動セット。状態変更で audit_logs。
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.workflow import PhaseCreate, PhaseResponse, PhaseUpdate

_COLS = 'id, project_id, "order", name, description, status, started_at, completed_at, created_at'

# Atelier 標準 9 工程 (canonical)。フロント lib/workflowPhases.ts CANONICAL_PHASES の
# label と 1:1 で一致させる (ダッシュボード S-B02 / 工程画面 S-F01 と表示を揃えるため)。
CANONICAL_PHASE_NAMES: tuple[str, ...] = (
    "ヒアリング",
    "要件定義",
    "アーキ設計",
    "デザイン",
    "機能分解",
    "タスク分解",
    "実装",
    "検証",
    "納品",
)


def _row_to_response(row: Any) -> PhaseResponse:
    return PhaseResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        order=int(row.order),
        name=str(row.name),
        description=(None if row.description is None else str(row.description)),
        status=row.status,
        started_at=row.started_at,
        completed_at=row.completed_at,
        created_at=row.created_at,
    )


async def list_phases(
    session: AsyncSession, *, project_id: str | None = None
) -> list[PhaseResponse]:
    where = ["1=1"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    res = await session.execute(
        text(f'select {_COLS} from public.phases where {" and ".join(where)} order by "order"'),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_phase(session: AsyncSession, phase_id: str) -> PhaseResponse | None:
    res = await session.execute(
        text(f"select {_COLS} from public.phases where id = cast(:id as uuid)"),
        {"id": phase_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_phase(session: AsyncSession, *, actor_id: str, data: PhaseCreate) -> PhaseResponse:
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            'insert into public.phases (id, project_id, "order", name, description) '
            "values (cast(:id as uuid), cast(:pid as uuid), :ord, :name, :desc)"
        ),
        {
            "id": new_id,
            "pid": data.project_id,
            "ord": data.order,
            "name": data.name,
            "desc": data.description,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="phase.create",
            target_type="phase",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"project_id": data.project_id, "order": data.order, "name": data.name},
        )
    )
    created = await get_phase(session, new_id)
    if created is None:  # pragma: no cover
        raise RuntimeError("created phase not visible after insert")
    return created


async def seed_default_phases(
    session: AsyncSession, *, actor_id: str, project_id: str
) -> list[PhaseResponse]:
    """project に canonical 9 工程を投入する (T-UC-10)。

    冪等: 既に phases が存在すれば何もせず現状を返す (二重投入しない)。
    先頭 (order 1 / ヒアリング) を in_progress + started_at=now()、残りは pending。
    """
    existing = await list_phases(session, project_id=project_id)
    if existing:
        return existing

    for i, name in enumerate(CANONICAL_PHASE_NAMES):
        params: dict[str, object] = {
            "id": str(uuid.uuid4()),
            "pid": project_id,
            "ord": i + 1,
            "name": name,
        }
        if i == 0:
            # 先頭工程は着手済みとして in_progress + started_at をセット
            sql = (
                'insert into public.phases (id, project_id, "order", name, status, started_at) '
                "values (cast(:id as uuid), cast(:pid as uuid), :ord, :name, "
                "        cast(:st as phase_status_enum), now())"
            )
            params["st"] = "in_progress"
        else:
            # 残りは DB 既定 (status=pending / started_at=null) に委ねる
            sql = (
                'insert into public.phases (id, project_id, "order", name) '
                "values (cast(:id as uuid), cast(:pid as uuid), :ord, :name)"
            )
        await session.execute(text(sql), params)

    await AuditWriter(session).write(
        AuditEvent(
            action="workflow.phases.seed",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"count": len(CANONICAL_PHASE_NAMES)},
        )
    )
    return await list_phases(session, project_id=project_id)


async def update_phase(
    session: AsyncSession, *, actor_id: str, phase_id: str, data: PhaseUpdate
) -> PhaseResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": phase_id}
    if data.name is not None:
        sets.append("name = :name")
        params["name"] = data.name
    if data.description is not None:
        sets.append("description = :desc")
        params["desc"] = data.description
    if data.status is not None:
        sets.append("status = cast(:st as phase_status_enum)")
        params["st"] = data.status
        # 遷移時に時刻を自動セット
        if data.status == "in_progress":
            sets.append("started_at = coalesce(started_at, now())")
        elif data.status == "completed":
            sets.append("completed_at = coalesce(completed_at, now())")
    if not sets:
        return await get_phase(session, phase_id)
    res = await session.execute(
        text(
            f"update public.phases set {', '.join(sets)} where id = cast(:id as uuid) returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="phase.update",
            target_type="phase",
            actor_type="user",
            actor_id=actor_id,
            target_id=phase_id,
            after={k: v for k, v in params.items() if k != "id"},
        )
    )
    return await get_phase(session, phase_id)


async def delete_phase(session: AsyncSession, *, actor_id: str, phase_id: str) -> bool:
    res = await session.execute(
        text("delete from public.phases where id = cast(:id as uuid) returning id"),
        {"id": phase_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="phase.delete",
            target_type="phase",
            actor_type="user",
            actor_id=actor_id,
            target_id=phase_id,
        )
    )
    return True
