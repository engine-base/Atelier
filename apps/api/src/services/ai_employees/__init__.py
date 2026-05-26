"""AI 社員 一覧・詳細・編集 サービス層 (T-A-14)。

RLS が効く AsyncSession を受け取り ai_employees を操作する。可視性/権限は RLS (T-D-21)。
10 名は固定 (作成/削除なし)。編集は display_name / icon / tone_preset / custom_tone_text のみ。
状態変更で audit_logs 記録。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.ai_employees import AiEmployeeResponse, AiEmployeeUpdate

_COLS = (
    "id, workspace_id, template_id, name, display_name, icon, role, department, "
    "tone_preset, custom_tone_text, attached_skills, attached_knowledge_cats, "
    "is_default, archived, created_at, updated_at"
)


def _row_to_response(row: Any) -> AiEmployeeResponse:
    return AiEmployeeResponse(
        id=str(row.id),
        workspace_id=str(row.workspace_id),
        template_id=(None if row.template_id is None else str(row.template_id)),
        name=str(row.name),
        display_name=str(row.display_name),
        icon=(None if row.icon is None else str(row.icon)),
        role=str(row.role),
        department=str(row.department),
        tone_preset=str(row.tone_preset),
        custom_tone_text=(None if row.custom_tone_text is None else str(row.custom_tone_text)),
        attached_skills=[str(x) for x in (row.attached_skills or [])],
        attached_knowledge_cats=[str(x) for x in (row.attached_knowledge_cats or [])],
        is_default=bool(row.is_default),
        archived=bool(row.archived),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_ai_employees(
    session: AsyncSession, *, workspace_id: str | None = None
) -> list[AiEmployeeResponse]:
    where = ["1=1"]
    params: dict[str, object] = {}
    if workspace_id is not None:
        where.append("workspace_id = cast(:wid as uuid)")
        params["wid"] = workspace_id
    res = await session.execute(
        text(
            f"select {_COLS} from public.ai_employees "
            f"where {' and '.join(where)} order by department, display_name"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_ai_employee(session: AsyncSession, employee_id: str) -> AiEmployeeResponse | None:
    res = await session.execute(
        text(f"select {_COLS} from public.ai_employees where id = cast(:id as uuid)"),
        {"id": employee_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def update_ai_employee(
    session: AsyncSession, *, actor_id: str, employee_id: str, data: AiEmployeeUpdate
) -> AiEmployeeResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": employee_id}
    if data.display_name is not None:
        sets.append("display_name = :dn")
        params["dn"] = data.display_name
    if data.icon is not None:
        sets.append("icon = :icon")
        params["icon"] = data.icon
    if data.tone_preset is not None:
        sets.append("tone_preset = cast(:tp as tone_preset_enum)")
        params["tp"] = data.tone_preset
    if data.custom_tone_text is not None:
        sets.append("custom_tone_text = :ctt")
        params["ctt"] = data.custom_tone_text
    if not sets:
        return await get_ai_employee(session, employee_id)
    res = await session.execute(
        text(
            f"update public.ai_employees set {', '.join(sets)} "
            "where id = cast(:id as uuid) returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="ai_employee.update",
            target_type="ai_employee",
            actor_type="user",
            actor_id=actor_id,
            target_id=employee_id,
        )
    )
    return await get_ai_employee(session, employee_id)
