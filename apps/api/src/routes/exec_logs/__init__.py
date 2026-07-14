"""実行ログ SSE 配信 ルータ (T-A-31)。

S-I03 実行モニタ画面用。E-013 task_executions の status / logs を
SSE 配信。認証 (401) + RLS (T-D-16) で cross-workspace 越境を担保。

実 worker stdout は F-BRIDGE01 worker が logs_storage_path に flush する
前提。本層は execution の状態遷移とメタデータの配信のみ責務とする。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.rate_limit import rate_limit_user
from src.schemas.exec_logs import ExecLogMeta
from src.services import exec_logs as svc

router = APIRouter(tags=["exec-logs"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get(
    "/executions/{execution_id}/logs",
    summary="実行ログメタデータ取得（non-streaming）",
)
async def get_exec_logs(
    execution_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ExecLogMeta]:
    meta = await svc.get_meta(session, execution_id)
    if meta is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "execution not found")
    return {"data": meta}


@router.get(
    "/executions/{execution_id}/logs/stream",
    summary="実行ログ SSE ストリーミング（status 変化を polling 配信）",
    dependencies=[Depends(rate_limit_user(60))],  # x-rate-limit: 60/min/user
)
async def stream_exec_logs(
    execution_id: str,
    session: SessionDep,
    _user: UserDep,
    poll_interval_seconds: Annotated[float, Query(ge=0.1, le=30.0)] = 2.0,
    max_duration_seconds: Annotated[float, Query(ge=1.0, le=600.0)] = 60.0,
) -> StreamingResponse:
    gen = svc.stream_logs(
        session,
        execution_id=execution_id,
        poll_interval_seconds=poll_interval_seconds,
        max_duration_seconds=max_duration_seconds,
    )
    return StreamingResponse(
        gen,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
