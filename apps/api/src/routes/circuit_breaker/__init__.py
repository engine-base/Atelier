"""サーキットブレーカ + PID ポーリング ルータ (T-A-29)。

F-DISP01 Dispatcher の信頼性運用。admin (JWT app_metadata.role='admin')
専用。breaker 状態の参照 / reset、stale running task の reclaim を提供。

認証 (401) + admin authz (403) + RLS (T-D-19)。state-changing call は
audit_logs に必ず記録 (3-tier AC: state-changing audit)。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.circuit_breaker import (
    CircuitBreakerState,
    CircuitResetRequest,
    PidPollRequest,
    PidPollResponse,
)
from src.services import circuit_breaker as svc

router = APIRouter(tags=["circuit-breaker"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


def _require_admin(user: CurrentUser) -> None:
    """JWT の app_metadata.role が 'admin' であることを要求する。"""
    app_metadata = user.claims.get("app_metadata")
    role: object = None
    if isinstance(app_metadata, dict):
        role = app_metadata.get("role")
    if role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin only")


@router.get(
    "/admin/circuit-breaker",
    summary="サーキットブレーカ現在状態",
)
async def get_circuit_breaker(
    session: SessionDep,
    user: UserDep,
    window_minutes: Annotated[int, Query(ge=1, le=60)] = 15,
    threshold: Annotated[float, Query(ge=0.0, le=1.0)] = 0.5,
) -> dict[str, CircuitBreakerState]:
    _require_admin(user)
    return {
        "data": await svc.evaluate_breaker(
            session, window_minutes=window_minutes, threshold=threshold
        )
    }


@router.post(
    "/admin/circuit-breaker/reset",
    summary="サーキットブレーカリセット (audit 記録)",
)
async def reset_circuit_breaker(
    body: CircuitResetRequest, session: SessionDep, user: UserDep
) -> dict[str, CircuitBreakerState]:
    _require_admin(user)
    return {"data": await svc.reset_breaker(session, actor_id=user.id, reason=body.reason)}


@router.post(
    "/admin/circuit-breaker/poll-pids",
    summary="PID ポーリング — stale running task を reclaim",
)
async def poll_pids(
    body: PidPollRequest, session: SessionDep, user: UserDep
) -> dict[str, PidPollResponse]:
    _require_admin(user)
    return {
        "data": await svc.poll_pids(
            session,
            actor_id=user.id,
            threshold_seconds=body.heartbeat_threshold_seconds,
            dry_run=body.dry_run,
        )
    }
