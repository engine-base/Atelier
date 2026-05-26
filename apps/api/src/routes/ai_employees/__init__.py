"""AI 社員 一覧・詳細・編集 ルータ (T-A-14)。

/ai-employees, /ai-employees/{id}。認証は get_current_user (401)、
可視性/権限は RLS (T-D-21) + 404/403。固定 10 名のため作成/削除は無い。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.ai_employees import AiEmployeeResponse, AiEmployeeUpdate
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
