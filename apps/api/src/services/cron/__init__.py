"""cron スケジュール サービス層 (T-A-40)。

RLS が効く AsyncSession を受け取り cron_schedules を CRUD する。
可視性: member、INSERT/UPDATE: owner/member、DELETE: owner のみ (RLS で enforce)。
target_payload は dict として受け取り JSONB で保存。状態変更は audit_logs 記録。
Inngest 連動 (next_run_at の自動計算 / job 投入) は T-F-20 で別途配線する。
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.cron import (
    CronScheduleCreate,
    CronScheduleResponse,
    CronScheduleUpdate,
)

_COLS = (
    "id, project_id, name, cron_expression, target_action, target_payload, "
    "enabled, next_run_at, created_at, updated_at"
)


def _payload(value: object) -> dict[str, object]:
    if value is None:
        return {}
    if isinstance(value, str):
        loaded: Any = json.loads(value)
        return loaded if isinstance(loaded, dict) else {}
    if isinstance(value, dict):
        return value
    return {}


def _row_to_response(row: Any) -> CronScheduleResponse:
    return CronScheduleResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        name=str(row.name),
        cron_expression=str(row.cron_expression),
        target_action=str(row.target_action),
        target_payload=_payload(row.target_payload),
        enabled=bool(row.enabled),
        next_run_at=row.next_run_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_schedules(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    enabled: bool | None = None,
) -> list[CronScheduleResponse]:
    where: list[str] = ["1=1"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if enabled is not None:
        where.append("enabled = :en")
        params["en"] = enabled
    res = await session.execute(
        text(
            f"select {_COLS} from public.cron_schedules "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_schedule(session: AsyncSession, schedule_id: str) -> CronScheduleResponse | None:
    res = await session.execute(
        text(f"select {_COLS} from public.cron_schedules where id = cast(:id as uuid)"),
        {"id": schedule_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_schedule(
    session: AsyncSession, *, actor_id: str, data: CronScheduleCreate
) -> CronScheduleResponse | None:
    new_id = str(uuid.uuid4())
    res = await session.execute(
        text(
            "insert into public.cron_schedules "
            "(id, project_id, name, cron_expression, target_action, target_payload, enabled) "
            "values (cast(:id as uuid), cast(:pid as uuid), :n, :ce, :ta, "
            " cast(:pl as jsonb), :en) returning id"
        ),
        {
            "id": new_id,
            "pid": data.project_id,
            "n": data.name,
            "ce": data.cron_expression,
            "ta": data.target_action,
            "pl": json.dumps(data.target_payload, ensure_ascii=False),
            "en": data.enabled,
        },
    )
    if res.scalar_one_or_none() is None:  # pragma: no cover - RLS は通常 raise
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="cron_schedule.create",
            target_type="cron_schedule",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={
                "project_id": data.project_id,
                "name": data.name,
                "cron_expression": data.cron_expression,
                "target_action": data.target_action,
            },
        )
    )
    return await get_schedule(session, new_id)


async def update_schedule(
    session: AsyncSession, *, actor_id: str, schedule_id: str, data: CronScheduleUpdate
) -> CronScheduleResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": schedule_id}
    if data.name is not None:
        sets.append("name = :n")
        params["n"] = data.name
    if data.cron_expression is not None:
        sets.append("cron_expression = :ce")
        params["ce"] = data.cron_expression
    if data.target_action is not None:
        sets.append("target_action = :ta")
        params["ta"] = data.target_action
    if data.target_payload is not None:
        sets.append("target_payload = cast(:pl as jsonb)")
        params["pl"] = json.dumps(data.target_payload, ensure_ascii=False)
    if data.enabled is not None:
        sets.append("enabled = :en")
        params["en"] = data.enabled
    if not sets:
        return await get_schedule(session, schedule_id)
    res = await session.execute(
        text(
            f"update public.cron_schedules set {', '.join(sets)} "
            "where id = cast(:id as uuid) returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="cron_schedule.update",
            target_type="cron_schedule",
            actor_type="user",
            actor_id=actor_id,
            target_id=schedule_id,
            after={k: v for k, v in params.items() if k != "id"},
        )
    )
    return await get_schedule(session, schedule_id)


async def delete_schedule(session: AsyncSession, *, actor_id: str, schedule_id: str) -> bool:
    res = await session.execute(
        text("delete from public.cron_schedules where id = cast(:id as uuid) returning id"),
        {"id": schedule_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="cron_schedule.delete",
            target_type="cron_schedule",
            actor_type="user",
            actor_id=actor_id,
            target_id=schedule_id,
        )
    )
    return True
