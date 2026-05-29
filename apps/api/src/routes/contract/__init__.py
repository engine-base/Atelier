"""API 契約凍結ルータ (T-A-45)。

GET  /contract/screen-coverage  — openapi.yaml × screens.json 比較レポート
GET  /contract/freeze-status    — 凍結状態 (audit_logs 由来)
POST /contract/freeze           — 凍結 (admin, screen coverage 100% 必須)
POST /contract/unfreeze         — 凍結解除 (admin)

screen-coverage は read-only ゆえ認証ユーザー全員可。freeze/unfreeze は
JWT の app_metadata.role='admin' のみ実行可能。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.contract import (
    FreezeRequest,
    FreezeStatus,
    ScreenCoverageReport,
)
from src.services import contract as svc

router = APIRouter(tags=["contract"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


def _require_admin(user: CurrentUser) -> None:
    app_metadata = user.claims.get("app_metadata")
    role: object = None
    if isinstance(app_metadata, dict):
        role = app_metadata.get("role")
    if role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin only")


@router.get(
    "/contract/screen-coverage",
    summary="screen × OpenAPI カバレッジレポート (Gate #9 と同条件)",
)
async def screen_coverage(_session: SessionDep, _user: UserDep) -> dict[str, ScreenCoverageReport]:
    return {"data": svc.compute_screen_coverage()}


@router.get(
    "/contract/freeze-status",
    summary="API 契約凍結状態",
)
async def freeze_status(session: SessionDep, _user: UserDep) -> dict[str, FreezeStatus]:
    return {"data": await svc.get_freeze_status(session)}


@router.post(
    "/contract/freeze",
    summary="API 契約凍結 (admin / 100% screen coverage 必須)",
)
async def freeze(
    body: FreezeRequest, session: SessionDep, user: UserDep
) -> dict[str, FreezeStatus]:
    _require_admin(user)
    try:
        result = await svc.freeze_contract(session, actor_id=user.id, note=body.note)
    except svc.ContractError as exc:
        if exc.code == "already_frozen":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        if exc.code == "screen_coverage_lt_100":
            raise HTTPException(status.HTTP_412_PRECONDITION_FAILED, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}


@router.post(
    "/contract/unfreeze",
    summary="API 契約凍結解除 (admin)",
)
async def unfreeze(
    body: FreezeRequest, session: SessionDep, user: UserDep
) -> dict[str, FreezeStatus]:
    _require_admin(user)
    try:
        result = await svc.unfreeze_contract(session, actor_id=user.id, note=body.note)
    except svc.ContractError as exc:
        if exc.code == "not_frozen":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}
