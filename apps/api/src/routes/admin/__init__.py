"""運営 admin ルータ (T-A-43 / T-A-42)。

T-A-43: GET /admin/audit-logs (監査ログ)。
T-A-42: GET /admin/skills[/{id}] + /admin/ai-employee-templates[/{id}]
        (運営 admin がスキル / AI 社員テンプレを横断管理 read-only)。
認証 (401) に加え admin (app_metadata.role=admin) でなければ 403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.admin import (
    AdminSkillResponse,
    AdminTemplateResponse,
    AuditLogResponse,
)
from src.services import admin as svc

router = APIRouter(tags=["admin"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/admin/audit-logs", summary="監査ログ閲覧（運営 admin）")
async def list_audit_logs(
    session: SessionDep,
    user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
    action: Annotated[str | None, Query()] = None,
    actor_type: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict[str, list[AuditLogResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    items = await svc.list_audit_logs(
        session,
        workspace_id=workspace_id,
        action=action,
        actor_type=actor_type,
        limit=limit,
    )
    return {"data": items}


# --------------------------------------------------------------------------- #
# T-A-42: 運営 admin スキル + AI 社員テンプレ管理 (read-only 閲覧)
# --------------------------------------------------------------------------- #
@router.get("/admin/skills", summary="運営 admin: スキル一覧（全件 / read-only）")
async def list_skills(
    session: SessionDep,
    user: UserDep,
    include_inactive: Annotated[bool, Query()] = True,
    name: Annotated[str | None, Query()] = None,
) -> dict[str, list[AdminSkillResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    return {
        "data": await svc.list_skills_admin(session, include_inactive=include_inactive, name=name)
    }


@router.get("/admin/skills/{skill_id}", summary="運営 admin: スキル詳細")
async def get_skill(
    skill_id: str, session: SessionDep, user: UserDep
) -> dict[str, AdminSkillResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    item = await svc.get_skill_admin(session, skill_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "skill not found")
    return {"data": item}


@router.get(
    "/admin/ai-employee-templates",
    summary="運営 admin: AI 社員テンプレ一覧（全件 / read-only）",
)
async def list_templates(
    session: SessionDep,
    user: UserDep,
    include_inactive: Annotated[bool, Query()] = True,
    department: Annotated[str | None, Query()] = None,
) -> dict[str, list[AdminTemplateResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    return {
        "data": await svc.list_templates_admin(
            session, include_inactive=include_inactive, department=department
        )
    }


@router.get(
    "/admin/ai-employee-templates/{template_id}",
    summary="運営 admin: AI 社員テンプレ詳細",
)
async def get_template(
    template_id: str, session: SessionDep, user: UserDep
) -> dict[str, AdminTemplateResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    item = await svc.get_template_admin(session, template_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    return {"data": item}
