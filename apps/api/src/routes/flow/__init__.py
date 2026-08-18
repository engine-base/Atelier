"""GAP-150: プロジェクトフロー ルータ。

GET  /projects/{project_id}/flow                     — フロー取得 (未初期化なら自動生成)
POST /projects/{project_id}/flow/{stage_key}/complete — 完了 (hard_gate は confirm 必須)
POST /projects/{project_id}/flow/{stage_key}/skip     — スキップ (理由必須)
POST /projects/{project_id}/flow/{stage_key}/reopen   — 差し戻し

認証 (401) + RLS (project 可視のみ、不可視は 404) + audit。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.flow import FlowCompleteRequest, FlowSkipRequest, FlowStageResponse
from src.services import flow as svc

router = APIRouter(tags=["flow"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


def _raise(exc: svc.FlowError) -> None:
    if exc.code == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
    if exc.code == "hard_gate":
        raise HTTPException(status.HTTP_403_FORBIDDEN, exc.message) from exc
    raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc


@router.get("/projects/{project_id}/flow", summary="プロジェクトフロー取得 (GAP-150)")
async def get_flow(
    project_id: str, session: SessionDep, user: UserDep
) -> dict[str, list[FlowStageResponse]]:
    flow = await svc.get_flow(session, actor_id=user.id, project_id=project_id)
    if flow is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    return {"data": flow}


@router.post(
    "/projects/{project_id}/flow/{stage_key}/complete",
    summary="ステージ完了 (GAP-150 — hard_gate は confirm 必須)",
)
async def complete_stage(
    project_id: str,
    stage_key: str,
    body: FlowCompleteRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, list[FlowStageResponse]]:
    try:
        flow = await svc.complete_stage(
            session,
            actor_id=user.id,
            project_id=project_id,
            stage_key=stage_key,
            confirm=body.confirm,
        )
    except svc.FlowError as exc:
        _raise(exc)
        raise  # unreachable — 型のため
    return {"data": flow}


@router.post(
    "/projects/{project_id}/flow/{stage_key}/skip",
    summary="ステージスキップ (GAP-150 — skippable のみ・理由必須)",
)
async def skip_stage(
    project_id: str,
    stage_key: str,
    body: FlowSkipRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, list[FlowStageResponse]]:
    try:
        flow = await svc.skip_stage(
            session,
            actor_id=user.id,
            project_id=project_id,
            stage_key=stage_key,
            reason=body.reason,
        )
    except svc.FlowError as exc:
        _raise(exc)
        raise
    return {"data": flow}


@router.post(
    "/projects/{project_id}/flow/{stage_key}/reopen",
    summary="ステージ差し戻し (GAP-150 — done/skipped → pending)",
)
async def reopen_stage(
    project_id: str, stage_key: str, session: SessionDep, user: UserDep
) -> dict[str, list[FlowStageResponse]]:
    try:
        flow = await svc.reopen_stage(
            session, actor_id=user.id, project_id=project_id, stage_key=stage_key
        )
    except svc.FlowError as exc:
        _raise(exc)
        raise
    return {"data": flow}


@router.post(
    "/projects/{project_id}/flow/{stage_key}/thread",
    summary="工程専用スレッドの取得/作成 (GAP-151 — 工程 = 会話の入れ物)",
)
async def ensure_stage_thread(
    project_id: str, stage_key: str, session: SessionDep, user: UserDep
) -> dict[str, dict[str, str]]:
    try:
        thread_id = await svc.ensure_stage_thread(
            session, actor_id=user.id, project_id=project_id, stage_key=stage_key
        )
    except svc.FlowError as exc:
        if exc.code == "no_employee":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        _raise(exc)
        raise
    return {"data": {"thread_id": thread_id}}
