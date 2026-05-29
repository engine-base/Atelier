"""実行モニター + Bridge 状態 ルータ (T-A-30)。

S-I03 実行モニタ画面用。E-013 task_executions 横断一覧 + Bridge worker
集約状態。read-only API。認証 (401) + RLS (T-D-16) で cross-workspace 越境
を担保 (R-T08 維持)。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.executions import (
    BridgeStatusResponse,
    ExecutionResponse,
    ExecutionStatus,
)
from src.services import executions as svc

router = APIRouter(tags=["executions"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/executions", summary="実行履歴一覧（実行モニタ）")
async def list_executions(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    task_id: Annotated[str | None, Query()] = None,
    exec_status: Annotated[ExecutionStatus | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, list[ExecutionResponse]]:
    return {
        "data": await svc.list_executions(
            session,
            project_id=project_id,
            task_id=task_id,
            status_filter=exec_status,
            limit=limit,
            offset=offset,
        )
    }


@router.get("/executions/{execution_id}", summary="実行詳細")
async def get_execution(
    execution_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ExecutionResponse]:
    ex = await svc.get_execution(session, execution_id)
    if ex is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "execution not found")
    return {"data": ex}


@router.get("/bridge/status", summary="Bridge worker 集約状態")
async def get_bridge_status(session: SessionDep, _user: UserDep) -> dict[str, BridgeStatusResponse]:
    return {"data": await svc.bridge_status(session)}
