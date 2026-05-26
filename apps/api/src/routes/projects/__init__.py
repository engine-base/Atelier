"""Project CRUD ルータ (T-A-10)。

07_api_design/openapi.yaml の /projects, /projects/{id} に対応。
認証は get_current_user (401)、可視性/権限は RLS (T-D-15) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.projects import (
    AccountAiLearning,
    AiLearningRequest,
    PaginationMeta,
    ProjectCreate,
    ProjectDashboard,
    ProjectResponse,
    ProjectUpdate,
)
from src.services import projects as svc

router = APIRouter(tags=["projects"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/projects", summary="プロジェクト一覧（カーソル）")
async def list_projects(
    session: SessionDep,
    _user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    cursor: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, list[ProjectResponse] | PaginationMeta]:
    items, meta = await svc.list_projects(
        session, workspace_id=workspace_id, status=status_filter, cursor=cursor, limit=limit
    )
    return {"data": items, "meta": meta}


@router.post("/projects", status_code=status.HTTP_201_CREATED, summary="新規プロジェクト")
async def create_project(
    body: ProjectCreate, session: SessionDep, user: UserDep
) -> dict[str, ProjectResponse]:
    created = await svc.create_project(session, actor_id=user.id, data=body)
    return {"data": created}


@router.get("/projects/{project_id}", summary="プロジェクト詳細")
async def get_project(
    project_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ProjectResponse]:
    proj = await svc.get_project(session, project_id)
    if proj is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    return {"data": proj}


@router.patch("/projects/{project_id}", summary="プロジェクト更新")
async def update_project(
    project_id: str, body: ProjectUpdate, session: SessionDep, user: UserDep
) -> dict[str, ProjectResponse]:
    if await svc.get_project(session, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    updated = await svc.update_project(session, actor_id=user.id, project_id=project_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update project")
    return {"data": updated}


@router.delete(
    "/projects/{project_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="プロジェクト削除（論理）",
)
async def delete_project(project_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_project(session, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    if not await svc.delete_project(session, actor_id=user.id, project_id=project_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete project")


@router.get("/projects/{project_id}/dashboard", summary="プロジェクト KPI ダッシュボード")
async def project_dashboard(
    project_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ProjectDashboard]:
    dash = await svc.get_dashboard(session, project_id)
    if dash is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    return {"data": dash}


@router.post("/projects/{project_id}/ai-learning", summary="プロジェクト単位 AI 学習 OFF")
async def set_project_ai_learning(
    project_id: str, body: AiLearningRequest, session: SessionDep, user: UserDep
) -> dict[str, ProjectResponse]:
    if await svc.get_project(session, project_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    updated = await svc.set_project_ai_learning(
        session, actor_id=user.id, project_id=project_id, opt_out=body.opt_out
    )
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to change ai-learning")
    return {"data": updated}


@router.post("/account/ai-learning", summary="アカウント単位 AI 学習 OFF")
async def set_account_ai_learning(
    body: AiLearningRequest, session: SessionDep, user: UserDep
) -> dict[str, AccountAiLearning]:
    result = await svc.set_account_ai_learning(session, actor_id=user.id, opt_out=body.opt_out)
    if result is None:  # pragma: no cover - 認証済 user は users 行を持つ
        raise HTTPException(status.HTTP_404_NOT_FOUND, "account not found")
    return {"data": result}
