"""スキル管理 ルータ (T-A-49 / F-007) — 運営 admin 専用の write。

GET /admin/skills[/{id}] は routes/admin (read-only, T-A-42) に存在する。
本ルータは write (POST/PATCH/DELETE/attach) を担当し、is_admin gate (403) +
service_role write (services.skills 内) + audit を行う。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from src.dependencies import CurrentUser, get_current_user
from src.schemas.admin import AdminSkillResponse
from src.schemas.skills import SkillAttachRequest, SkillCreate, SkillUpdate
from src.services import admin as admin_svc
from src.services import skills as svc

router = APIRouter(tags=["skills"])

UserDep = Annotated[CurrentUser, Depends(get_current_user)]


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
