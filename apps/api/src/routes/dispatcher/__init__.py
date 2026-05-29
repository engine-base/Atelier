"""Hermes 互換 kanban_tools ルータ (T-A-28)。

Bridge worker (F-BRIDGE01) からの 7 ツール HTTP endpoint。
X-Bridge-Token ヘッダで認証 (Supabase JWT とは独立)。トークン一致時は
service_role 相当のフルアクセスセッションを払い出し、RLS をバイパスする
(worker は全 workspace の queued task に到達する必要がある)。

7 endpoint:
- POST /kanban/pick            : queued task 確保 → spawning
- POST /kanban/start           : spawning → running
- POST /kanban/complete        : running → done|awaiting (Hermes 既存)
- POST /kanban/request-review  : running → awaiting
- POST /kanban/request-change  : running → blocked
- POST /kanban/heartbeat       : worker heartbeat (PID dead-man switch)
- POST /kanban/kill            : 強制終了 → reclaimed
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from functools import lru_cache
from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.schemas.dispatcher import (
    KanbanCompleteRequest,
    KanbanHeartbeatRequest,
    KanbanKillRequest,
    KanbanPickRequest,
    KanbanPickResponse,
    KanbanRequestChangeRequest,
    KanbanRequestReviewRequest,
    KanbanResponse,
    KanbanStartRequest,
)
from src.services.dispatcher import bridge_tools as svc

router = APIRouter(tags=["kanban-tools"])


@lru_cache(maxsize=1)
def _bridge_session_factory() -> async_sessionmaker[AsyncSession]:
    return create_session_factory(create_engine())


async def verify_bridge_token(
    x_bridge_token: Annotated[str | None, Header()] = None,
) -> str:
    """X-Bridge-Token を環境変数 ATELIER_BRIDGE_TOKEN と照合する。

    未設定の場合は 500 (誤設定を明示)。不一致は 401。
    """
    expected = os.environ.get("ATELIER_BRIDGE_TOKEN")
    if not expected:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "bridge token not configured (set ATELIER_BRIDGE_TOKEN)",
        )
    if not x_bridge_token or x_bridge_token != expected:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid bridge token")
    return x_bridge_token


async def get_bridge_session() -> AsyncGenerator[AsyncSession, None]:
    """Bridge worker 向け service_role 相当の AsyncSession を払い出す。

    RLS バイパス (role を下げない)。例外時 rollback、正常時 commit。
    test では本依存のみを override し token 検証は経路通りに走らせる。
    """
    factory = _bridge_session_factory()
    async with factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()


BridgeAuth = Annotated[str, Depends(verify_bridge_token)]
BridgeSession = Annotated[AsyncSession, Depends(get_bridge_session)]


def _raise_for(code: str, message: str) -> NoReturn:
    if code == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, message)
    if code == "invalid_state":
        raise HTTPException(status.HTTP_409_CONFLICT, message)
    raise HTTPException(status.HTTP_400_BAD_REQUEST, message)


@router.post("/kanban/pick", summary="kanban_pick (Hermes 互換)")
async def kanban_pick(
    body: KanbanPickRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanPickResponse]:
    result, exec_id, wt = await svc.pick_task(
        session, worker_pid=body.worker_pid, project_id=body.project_id
    )
    if result is None:
        return {"data": KanbanPickResponse(no_available_task=True)}
    return {
        "data": KanbanPickResponse(
            task_id=result.task_id,
            execution_id=exec_id,
            worktree_path=wt,
            no_available_task=False,
        )
    }


@router.post("/kanban/start", summary="kanban_start (Hermes 互換)")
async def kanban_start(
    body: KanbanStartRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    try:
        result = await svc.start_task(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            worker_pid=body.worker_pid,
            claude_code_session_id=body.claude_code_session_id,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/complete", summary="kanban_complete (Hermes 互換)")
async def kanban_complete(
    body: KanbanCompleteRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    try:
        result = await svc.complete_task(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            summary=body.summary,
            metadata=body.metadata,
            auto_approve=body.auto_approve,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/request-review", summary="kanban_request_review (Hermes 互換)")
async def kanban_request_review(
    body: KanbanRequestReviewRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    try:
        result = await svc.request_review(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            note=body.note,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/request-change", summary="kanban_request_change (Hermes 互換)")
async def kanban_request_change(
    body: KanbanRequestChangeRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    try:
        result = await svc.request_change(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            reason=body.reason,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/heartbeat", summary="kanban_heartbeat (dead-man switch)")
async def kanban_heartbeat(
    body: KanbanHeartbeatRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    try:
        result = await svc.heartbeat(session, task_id=body.task_id, worker_pid=body.worker_pid)
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}


@router.post("/kanban/kill", summary="kanban_kill (強制終了)")
async def kanban_kill(
    body: KanbanKillRequest, session: BridgeSession, _token: BridgeAuth
) -> dict[str, KanbanResponse]:
    try:
        result = await svc.kill_task(
            session,
            task_id=body.task_id,
            execution_id=body.execution_id,
            reason=body.reason,
        )
    except svc.DispatcherError as exc:
        _raise_for(exc.code, exc.message)
    return {"data": result}
