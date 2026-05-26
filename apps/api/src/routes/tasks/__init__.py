"""Task CRUD + 受入条件取得 ルータ (T-A-26)。

07_api_design/openapi.yaml の /tasks, /tasks/{id}, /tasks/{id}/acceptance-criteria。
認証は get_current_user (401)、可視性/権限は RLS (T-D-16) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.tasks import (
    AcceptanceCriteriaResponse,
    TaskCreate,
    TaskResponse,
    TaskUpdate,
)
from src.services import tasks as svc

router = APIRouter(tags=["tasks"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/tasks", summary="タスク一覧")
async def list_tasks(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    lifecycle_stage: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[TaskResponse]]:
    items = await svc.list_tasks(
        session, project_id=project_id, lifecycle_stage=lifecycle_stage, limit=limit
    )
    return {"data": items}


@router.post("/tasks", status_code=status.HTTP_201_CREATED, summary="タスク作成")
async def create_task(
    body: TaskCreate, session: SessionDep, user: UserDep
) -> dict[str, TaskResponse]:
    return {"data": await svc.create_task(session, actor_id=user.id, data=body)}


@router.get("/tasks/{task_id}", summary="タスク詳細")
async def get_task(task_id: str, session: SessionDep, _user: UserDep) -> dict[str, TaskResponse]:
    task = await svc.get_task(session, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    return {"data": task}


@router.patch("/tasks/{task_id}", summary="タスク更新")
async def update_task(
    task_id: str, body: TaskUpdate, session: SessionDep, user: UserDep
) -> dict[str, TaskResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    updated = await svc.update_task(session, actor_id=user.id, task_id=task_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update task")
    return {"data": updated}


@router.delete(
    "/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT, summary="タスク削除（論理）"
)
async def delete_task(task_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    if not await svc.delete_task(session, actor_id=user.id, task_id=task_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete task")


@router.get("/tasks/{task_id}/acceptance-criteria", summary="受入条件取得")
async def get_acceptance_criteria(
    task_id: str, session: SessionDep, _user: UserDep
) -> dict[str, AcceptanceCriteriaResponse]:
    # task 自体が不可視 (RLS) なら 404
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    ac = await svc.get_acceptance_criteria(session, task_id)
    if ac is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "acceptance criteria not found")
    return {"data": ac}
