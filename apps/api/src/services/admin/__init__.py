"""運営 admin サービス層 (T-A-43 / T-A-42)。

T-A-43: audit_logs 閲覧 (RLS T-D-19 で admin 所属 workspace scope)。
T-A-42: 全 skills + ai_employee_templates 横断管理 (read-only)。RLS は
        skills_select_all / ai_employee_templates_select_all (TO authenticated
        USING true) を信頼源で、is_admin チェックでアクセス制御。
状態変更は無い (read-only)。
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser
from src.schemas.admin import AdminSkillResponse, AdminTemplateResponse, AuditLogResponse

_COLS = (
    "id, workspace_id, actor_type, actor_id, action, target_type, target_id, "
    "before, after, cast(ip_address as text) as ip_address, created_at"
)


def is_admin(user: CurrentUser) -> bool:
    """JWT の app_metadata.role / user_metadata.role が 'admin' か。"""
    claims = user.claims
    for key in ("app_metadata", "user_metadata"):
        meta = claims.get(key)
        if isinstance(meta, dict) and meta.get("role") == "admin":
            return True
    return claims.get("user_role") == "admin"


def _json(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    if isinstance(value, str):
        loaded: Any = json.loads(value)
        return loaded if isinstance(loaded, dict) else None
    if isinstance(value, dict):
        return value
    return None


def _row_to_response(row: Any) -> AuditLogResponse:
    return AuditLogResponse(
        id=str(row.id),
        workspace_id=(None if row.workspace_id is None else str(row.workspace_id)),
        actor_type=str(row.actor_type),
        actor_id=str(row.actor_id),
        action=str(row.action),
        target_type=str(row.target_type),
        target_id=(None if row.target_id is None else str(row.target_id)),
        before=_json(row.before),
        after=_json(row.after),
        ip_address=(None if row.ip_address is None else str(row.ip_address)),
        created_at=row.created_at,
    )


_SKILL_COLS = (
    "id, name, version, description, content_md, assets_storage_path, "
    "allowed_employee_roles, allowed_employee_ids, is_active, created_at, updated_at"
)

_TPL_COLS = (
    "id, default_name, default_display_name, default_icon, department, role, "
    "default_skills, default_knowledge_cats, system_prompt, specialty, version, "
    "is_active, created_at, updated_at"
)


def _skill_to_response(row: Any) -> AdminSkillResponse:
    return AdminSkillResponse(
        id=str(row.id),
        name=str(row.name),
        version=str(row.version),
        description=(None if row.description is None else str(row.description)),
        content_md=str(row.content_md),
        assets_storage_path=(
            None if row.assets_storage_path is None else str(row.assets_storage_path)
        ),
        allowed_employee_roles=[str(r) for r in (row.allowed_employee_roles or [])],
        allowed_employee_ids=[str(i) for i in (row.allowed_employee_ids or [])],
        is_active=bool(row.is_active),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _tpl_to_response(row: Any) -> AdminTemplateResponse:
    return AdminTemplateResponse(
        id=str(row.id),
        default_name=str(row.default_name),
        default_display_name=str(row.default_display_name),
        default_icon=(None if row.default_icon is None else str(row.default_icon)),
        department=str(row.department),
        role=str(row.role),
        default_skills=[str(s) for s in (row.default_skills or [])],
        default_knowledge_cats=[str(c) for c in (row.default_knowledge_cats or [])],
        system_prompt=str(row.system_prompt),
        specialty=str(row.specialty),
        version=int(row.version),
        is_active=bool(row.is_active),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_skills_admin(
    session: AsyncSession, *, include_inactive: bool = True, name: str | None = None
) -> list[AdminSkillResponse]:
    """admin 横断: 全 skills 一覧。RLS skills_select_all。"""
    where: list[str] = ["1=1"]
    params: dict[str, object] = {}
    if not include_inactive:
        where.append("is_active = true")
    if name is not None:
        where.append("name = :n")
        params["n"] = name
    res = await session.execute(
        text(
            f"select {_SKILL_COLS} from public.skills "
            f"where {' and '.join(where)} order by name, version desc"
        ),
        params,
    )
    return [_skill_to_response(r) for r in res.all()]


async def get_skill_admin(session: AsyncSession, skill_id: str) -> AdminSkillResponse | None:
    res = await session.execute(
        text(f"select {_SKILL_COLS} from public.skills where id = cast(:id as uuid)"),
        {"id": skill_id},
    )
    row = res.first()
    return None if row is None else _skill_to_response(row)


async def list_templates_admin(
    session: AsyncSession,
    *,
    include_inactive: bool = True,
    department: str | None = None,
) -> list[AdminTemplateResponse]:
    """admin 横断: 全 AI 社員テンプレ。RLS ai_employee_templates_select_all。"""
    where: list[str] = ["1=1"]
    params: dict[str, object] = {}
    if not include_inactive:
        where.append("is_active = true")
    if department is not None:
        where.append("department = cast(:d as ai_employee_department_enum)")
        params["d"] = department
    res = await session.execute(
        text(
            f"select {_TPL_COLS} from public.ai_employee_templates "
            f"where {' and '.join(where)} order by department, default_name, version desc"
        ),
        params,
    )
    return [_tpl_to_response(r) for r in res.all()]


async def get_template_admin(
    session: AsyncSession, template_id: str
) -> AdminTemplateResponse | None:
    res = await session.execute(
        text(f"select {_TPL_COLS} from public.ai_employee_templates where id = cast(:id as uuid)"),
        {"id": template_id},
    )
    row = res.first()
    return None if row is None else _tpl_to_response(row)


async def list_audit_logs(
    session: AsyncSession,
    *,
    workspace_id: str | None = None,
    action: str | None = None,
    actor_type: str | None = None,
    limit: int = 100,
) -> list[AuditLogResponse]:
    limit = max(1, min(limit, 500))
    where = ["1=1"]
    params: dict[str, object] = {"lim": limit}
    if workspace_id is not None:
        where.append("workspace_id = cast(:wid as uuid)")
        params["wid"] = workspace_id
    if action is not None:
        where.append("action = :act")
        params["act"] = action
    if actor_type is not None:
        where.append("actor_type = :at")
        params["at"] = actor_type
    res = await session.execute(
        text(
            f"select {_COLS} from public.audit_logs "
            f"where {' and '.join(where)} order by created_at desc limit :lim"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]
