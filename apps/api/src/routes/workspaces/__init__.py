"""Workspace CRUD ルータ (T-A-06)。

07_api_design/openapi.yaml の /workspaces, /workspaces/{id} に対応。
認証は get_current_user (401)、可視性/権限は RLS (T-D-15) + 404/403 で表現。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.workspaces import (
    WorkspaceCreate,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from src.services import workspaces as svc

router = APIRouter(tags=["workspaces"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/workspaces", summary="所属 WS 一覧")
async def list_workspaces(
    session: SessionDep, _user: UserDep
) -> dict[str, list[WorkspaceResponse]]:
    return {"data": await svc.list_workspaces(session)}


@router.post("/workspaces", status_code=status.HTTP_201_CREATED, summary="新規 WS 作成")
async def create_workspace(
    body: WorkspaceCreate, session: SessionDep, user: UserDep
) -> dict[str, WorkspaceResponse]:
    created = await svc.create_workspace(session, owner_user_id=user.id, data=body)
    return {"data": created}


@router.get("/workspaces/{workspace_id}", summary="WS 詳細")
async def get_workspace(
    workspace_id: str, session: SessionDep, _user: UserDep
) -> dict[str, WorkspaceResponse]:
    ws = await svc.get_workspace(session, workspace_id)
    if ws is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
    return {"data": ws}


@router.patch("/workspaces/{workspace_id}", summary="WS 更新")
async def update_workspace(
    workspace_id: str, body: WorkspaceUpdate, session: SessionDep, user: UserDep
) -> dict[str, WorkspaceResponse]:
    # 可視か (RLS SELECT) を先に確認: 不可視 = 404
    if await svc.get_workspace(session, workspace_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
    updated = await svc.update_workspace(
        session, actor_id=user.id, workspace_id=workspace_id, data=body
    )
    # 可視だが UPDATE が 0 行 = RLS write policy 拒否 (権限なし) = 403
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update workspace")
    return {"data": updated}


@router.delete(
    "/workspaces/{workspace_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="WS 削除 (論理)",
)
async def delete_workspace(workspace_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_workspace(session, workspace_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "workspace not found")
    if not await svc.delete_workspace(session, actor_id=user.id, workspace_id=workspace_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete workspace")
