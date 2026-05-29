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
    PlayTaskRequest,
    PlayTaskResponse,
    TaskBulkLifecycleRequest,
    TaskBulkLifecycleResponse,
    TaskCreate,
    TaskDecisionRequest,
    TaskExecutionResponse,
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


@router.get("/tasks/{task_id}/executions", summary="タスク実行履歴")
async def list_executions(
    task_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[TaskExecutionResponse]]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    return {"data": await svc.list_executions(session, task_id=task_id)}


@router.get("/tasks/{task_id}/executions/{execution_id}", summary="タスク実行詳細・スコア")
async def get_execution(
    task_id: str, execution_id: str, session: SessionDep, _user: UserDep
) -> dict[str, TaskExecutionResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    ex = await svc.get_execution(session, task_id=task_id, execution_id=execution_id)
    if ex is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task execution not found")
    return {"data": ex}


# --------------------------------------------------------------------------- #
# T-A-25: タスク一括再生 + 承認/差戻/再試行
# --------------------------------------------------------------------------- #
@router.post(
    "/tasks/bulk/lifecycle",
    summary="タスク lifecycle 一括遷移（再生 / 承認等の bulk 操作）",
)
async def bulk_lifecycle(
    body: TaskBulkLifecycleRequest, session: SessionDep, user: UserDep
) -> dict[str, TaskBulkLifecycleResponse]:
    return {"data": await svc.bulk_lifecycle(session, actor_id=user.id, data=body)}


@router.post("/tasks/{task_id}/approve", summary="タスク承認 (awaiting → done)")
async def approve_task(
    task_id: str,
    body: TaskDecisionRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, TaskResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    updated = await svc.approve_task(session, actor_id=user.id, task_id=task_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "task is not awaiting (cannot approve)")
    return {"data": updated}


@router.post("/tasks/{task_id}/reject", summary="タスク差戻 (awaiting → blocked)")
async def reject_task(
    task_id: str,
    body: TaskDecisionRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, TaskResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    updated = await svc.reject_task(session, actor_id=user.id, task_id=task_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "task is not awaiting (cannot reject)")
    return {"data": updated}


@router.post(
    "/tasks/{task_id}/retry",
    summary="タスク再試行 (blocked → ready, retry_count += 1)",
)
async def retry_task(
    task_id: str,
    body: TaskDecisionRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, TaskResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    updated = await svc.retry_task(session, actor_id=user.id, task_id=task_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "task is not blocked (cannot retry)")
    return {"data": updated}


# --------------------------------------------------------------------------- #
# T-A-24: タスク再生 API (/tasks/{id}/play, dispatcher 連動)
# openapi.yaml では path 変数を {id} で公開 (PlayTask 仕様)。
# --------------------------------------------------------------------------- #
@router.post(
    "/tasks/{id}/play",
    status_code=status.HTTP_202_ACCEPTED,
    summary="タスク再生（dispatcher へ）",
)
async def play_task(
    id: str,
    body: PlayTaskRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, PlayTaskResponse]:
    result, payload = await svc.play_task(session, actor_id=user.id, task_id=id, data=body)
    if result == svc.PlayResult.NOT_FOUND:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    if result == svc.PlayResult.INVALID_STATE:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "task is not in a playable lifecycle (ready / blocked)",
        )
    if result == svc.PlayResult.DEPS_UNMET:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "task dependencies are not all done (use force=true to override)",
        )
    assert payload is not None
    return {"data": payload}
