"""AI 社員 一覧・詳細・編集 + テンプレ閲覧 ルータ (T-A-14 / T-A-15)。

/ai-employees, /ai-employees/{id}。認証は get_current_user (401)、
可視性/権限は RLS (T-D-21) + 404/403。固定 10 名のため作成/削除は無い。
T-A-15: /ai-employees/templates[/{id}] は運営側固定テンプレの read-only 閲覧。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.ai_employees import (
    AiEmployeeResponse,
    AiEmployeeTemplateResponse,
    AiEmployeeUpdate,
)
from src.services import ai_employees as svc

router = APIRouter(tags=["ai-employees"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/ai-employees", summary="AI 社員一覧")
async def list_ai_employees(
    session: SessionDep,
    _user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
) -> dict[str, list[AiEmployeeResponse]]:
    return {"data": await svc.list_ai_employees(session, workspace_id=workspace_id)}


# NOTE: /ai-employees/templates は /ai-employees/{employee_id} より前に宣言する
# (後だと employee_id="templates" として捕捉されてしまうため)。
@router.get("/ai-employees/templates", summary="AI 社員テンプレ一覧（運営側固定）")
async def list_templates(
    session: SessionDep,
    _user: UserDep,
    department: Annotated[str | None, Query()] = None,
    active_only: Annotated[bool, Query()] = True,
) -> dict[str, list[AiEmployeeTemplateResponse]]:
    return {
        "data": await svc.list_templates(session, department=department, active_only=active_only)
    }


@router.get("/ai-employees/templates/{template_id}", summary="AI 社員テンプレ詳細")
async def get_template(
    template_id: str, session: SessionDep, _user: UserDep
) -> dict[str, AiEmployeeTemplateResponse]:
    tpl = await svc.get_template(session, template_id)
    if tpl is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee template not found")
    return {"data": tpl}


@router.get("/ai-employees/{employee_id}", summary="AI 社員詳細")
async def get_ai_employee(
    employee_id: str, session: SessionDep, _user: UserDep
) -> dict[str, AiEmployeeResponse]:
    emp = await svc.get_ai_employee(session, employee_id)
    if emp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee not found")
    return {"data": emp}


@router.patch("/ai-employees/{employee_id}", summary="AI 社員編集")
async def update_ai_employee(
    employee_id: str, body: AiEmployeeUpdate, session: SessionDep, user: UserDep
) -> dict[str, AiEmployeeResponse]:
    if await svc.get_ai_employee(session, employee_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee not found")
    updated = await svc.update_ai_employee(
        session, actor_id=user.id, employee_id=employee_id, data=body
    )
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update ai employee")
    return {"data": updated}
