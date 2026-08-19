"""cron スケジュール サービス層 (T-A-40)。

RLS が効く AsyncSession を受け取り cron_schedules を CRUD する。
可視性: member、INSERT/UPDATE: owner/member、DELETE: owner のみ (RLS で enforce)。
target_payload は dict として受け取り JSONB で保存。状態変更は audit_logs 記録。
GAP-179: next_run_at は cron_expression (日本時間で解釈) から算出して保存する。
発火は services/cron/dispatcher.run_due_schedules が 1 分ごとに行う。
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any, cast
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.cron import (
    CronScheduleCreate,
    CronScheduleResponse,
    CronScheduleUpdate,
)

from .expression import next_occurrence

UTC = ZoneInfo("UTC")

_COLS = (
    "id, project_id, name, cron_expression, target_action, target_payload, "
    "enabled, next_run_at, created_at, updated_at"
)


def _payload(value: object) -> dict[str, object]:
    if value is None:
        return {}
    if isinstance(value, str):
        loaded: Any = json.loads(value)
        return cast("dict[str, object]", loaded) if isinstance(loaded, dict) else {}
    if isinstance(value, dict):
        return cast("dict[str, object]", value)
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
    # 式が不正なら CronExpressionError (route が 422 + 日本語メッセージにする)。
    # 保存できて発火しない行を作らない。
    next_run = next_occurrence(data.cron_expression, after=datetime.now(tz=UTC))
    res = await session.execute(
        text(
            "insert into public.cron_schedules "
            "(id, project_id, name, cron_expression, target_action, target_payload, "
            " enabled, next_run_at) "
            "values (cast(:id as uuid), cast(:pid as uuid), :n, :ce, :ta, "
            " cast(:pl as jsonb), :en, :nr) returning id"
        ),
        {
            "id": new_id,
            "nr": next_run if data.enabled else None,
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

    # next_run_at は 1 箇所でだけ決める (式変更・有効化/無効化のどちらでも矛盾しない)。
    if data.cron_expression is not None or data.enabled is not None:
        current = await get_schedule(session, schedule_id)
        will_be_enabled = (
            data.enabled
            if data.enabled is not None
            else (current.enabled if current is not None else True)
        )
        expression = data.cron_expression or (
            current.cron_expression if current is not None else None
        )
        if not will_be_enabled or expression is None:
            # 止めたのに「次回」が出ているのは嘘なので消す
            sets.append("next_run_at = null")
        else:
            sets.append("next_run_at = :nr")
            params["nr"] = next_occurrence(expression, after=datetime.now(tz=UTC))
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
