"""スキル管理 ルータ (T-A-49 / F-007)。

- GET /skills: 認証ユーザー向けカタログ一覧 (read-only, RLS skills_select_all。
  S-C01/S-C02 が社員の attached_skills uuid を名前解決するのに使う)
- write (POST/PATCH/DELETE/attach) は運営 admin 専用: is_admin gate (403) +
  service_role write (services.skills 内) + audit。
- GET /admin/skills[/{id}] は routes/admin (read-only, T-A-42) に存在する。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.admin import AdminSkillResponse
from src.schemas.skills import (
    SkillAttachRequest,
    SkillCreate,
    SkillLiteResponse,
    SkillUpdate,
)
from src.services import admin as admin_svc
from src.services import skills as svc

router = APIRouter(tags=["skills"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/skills", summary="スキルカタログ一覧（認証ユーザー read-only）")
async def list_skills(
    session: SessionDep,
    _user: UserDep,
    active_only: Annotated[bool, Query()] = True,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> dict[str, list[SkillLiteResponse]]:
    return {"data": await svc.list_skills(session, active_only=active_only, limit=limit)}


def _require_admin(user: CurrentUser) -> None:
    if not admin_svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")


@router.post(
    "/admin/skills",
    status_code=status.HTTP_201_CREATED,
    summary="運営 admin: スキル新規登録（SKILL.md upload）",
)
async def create_skill(body: SkillCreate, user: UserDep) -> dict[str, AdminSkillResponse]:
    _require_admin(user)
    return {"data": await svc.create_skill(actor_id=user.id, data=body)}


@router.patch("/admin/skills/{skill_id}", summary="運営 admin: スキル編集")
async def update_skill(
    skill_id: str, body: SkillUpdate, user: UserDep
) -> dict[str, AdminSkillResponse]:
    _require_admin(user)
    item = await svc.update_skill(actor_id=user.id, skill_id=skill_id, data=body)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "skill not found")
    return {"data": item}


@router.delete(
    "/admin/skills/{skill_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="運営 admin: スキル削除",
)
async def delete_skill(skill_id: str, user: UserDep) -> None:
    _require_admin(user)
    if not await svc.delete_skill(actor_id=user.id, skill_id=skill_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "skill not found")


@router.post(
    "/admin/skills/{skill_id}/attach",
    summary="運営 admin: スキルを AI 社員に装着 / 解除",
)
async def attach_skill(skill_id: str, body: SkillAttachRequest, user: UserDep) -> dict[str, bool]:
    _require_admin(user)
    if not await svc.attach_skill(actor_id=user.id, skill_id=skill_id, data=body):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai_employee not found")
    return {"data": True}
