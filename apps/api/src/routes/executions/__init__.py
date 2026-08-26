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
    DispatchControlResponse,
    DispatchPromoteResponse,
    ExecutionEvent,
    ExecutionResponse,
    ExecutionStatus,
    ExecutionTestResult,
)
from src.services import executions as svc
from src.user_messages import user_detail

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
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の実行記録が見つかりません。")
    return {"data": ex}


@router.get("/bridge/status", summary="Bridge worker 集約状態")
async def get_bridge_status(session: SessionDep, _user: UserDep) -> dict[str, BridgeStatusResponse]:
    return {"data": await svc.bridge_status(session)}


@router.get("/executions-events", summary="実行イベント集約 (GAP-026⑤ — S-I03 ログ集約ビュー)")
async def list_execution_events(
    session: SessionDep,
    _user: UserDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[ExecutionEvent]]:
    """実 task_executions から導出した開始/終了イベント列 (RLS 可視分のみ)。"""
    return {"data": await svc.list_execution_events(session, limit=limit)}


@router.post("/dispatch/pause", summary="すべて一時停止 (GAP-026② — 新規 pick を止める)")
async def pause_dispatch(session: SessionDep, user: UserDep) -> dict[str, DispatchControlResponse]:
    return {"data": await svc.set_dispatch_paused(session, actor_id=user.id, paused=True)}


@router.post("/dispatch/resume", summary="ディスパッチ再開 (GAP-026②)")
async def resume_dispatch(session: SessionDep, user: UserDep) -> dict[str, DispatchControlResponse]:
    return {"data": await svc.set_dispatch_paused(session, actor_id=user.id, paused=False)}


@router.post(
    "/dispatch/promote",
    summary="順番待ちから 1 件追加 (GAP-026② — 次の pick で最優先)",
)
async def promote_dispatch(
    session: SessionDep, user: UserDep
) -> dict[str, DispatchPromoteResponse]:
    try:
        result = await svc.promote_next_queued(session, actor_id=user.id)
    except svc.DispatchOpsError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, user_detail(exc)) from exc
    return {"data": result}


@router.post(
    "/tasks/{task_id}/dispatch-cancel",
    summary="キュー取消 (GAP-026③ — queued の dispatch を解除)",
)
async def cancel_task_dispatch(
    task_id: str, session: SessionDep, user: UserDep
) -> dict[str, dict[str, str]]:
    try:
        ok = await svc.cancel_queued_dispatch(session, actor_id=user.id, task_id=task_id)
    except svc.DispatchOpsError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, user_detail(exc)) from exc
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    return {"data": {"task_id": task_id, "dispatch_status": ""}}


@router.post(
    "/tasks/{task_id}/dispatch-stop",
    summary="セッション停止 (GAP-026④ — 実行を cancelled で閉じ reclaimed へ)",
)
async def stop_task_dispatch(
    task_id: str, session: SessionDep, user: UserDep
) -> dict[str, dict[str, str]]:
    try:
        ok = await svc.stop_dispatch(session, actor_id=user.id, task_id=task_id)
    except svc.DispatchOpsError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, user_detail(exc)) from exc
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    return {"data": {"task_id": task_id, "dispatch_status": "reclaimed"}}


@router.get(
    "/executions/{execution_id}/tests",
    summary="テストケース単位の結果 (GAP-025② — S-I02 テスト結果タブ)",
)
async def list_execution_tests(
    execution_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[ExecutionTestResult]]:
    items = await svc.list_execution_tests(session, execution_id=execution_id)
    if items is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の実行記録が見つかりません。")
    return {"data": items}
