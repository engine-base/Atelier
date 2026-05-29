"""承認待ちインボックス (approval_inbox) ルータ (T-A-32)。

/approvals[/{id}][/decide]。認証 (401) + RLS (本人のみ) + 404。
5 種統合: task_approval / phase_approval / knowledge_write / comment_response /
scope_change を一つの inbox に集約し、decide で承認/差戻を行う。
状態変更 (decide) は audit_logs に記録。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.approvals import (
    ApprovalDecideRequest,
    ApprovalResponse,
    ApprovalStatus,
    ApprovalType,
)
from src.services import approvals as svc

router = APIRouter(tags=["approvals"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/approval-inbox", summary="承認待ちインボックス一覧（本人 / 5 種統合）")
async def list_approvals(
    session: SessionDep,
    _user: UserDep,
    status_filter: Annotated[ApprovalStatus | None, Query(alias="status")] = None,
    type_filter: Annotated[ApprovalType | None, Query(alias="type")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[ApprovalResponse]]:
    return {
        "data": await svc.list_approvals(
            session,
            status_filter=status_filter,
            type_filter=type_filter,
            limit=limit,
        )
    }


@router.get("/approval-inbox/{approval_id}", summary="承認待ち詳細（本人）")
async def get_approval(
    approval_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ApprovalResponse]:
    item = await svc.get_approval(session, approval_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")
    return {"data": item}


@router.post("/approval-inbox/{approval_id}/decide", summary="承認 / 差戻 (本人)")
async def decide_approval(
    approval_id: str,
    body: ApprovalDecideRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, ApprovalResponse]:
    # 不在 / 不可視 (越境) は 404
    if await svc.get_approval(session, approval_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "approval not found")
    decided = await svc.decide_approval(
        session, actor_id=user.id, approval_id=approval_id, data=body
    )
    if decided is None:
        # 既に解決済 (status != pending) → 409 Conflict
        raise HTTPException(status.HTTP_409_CONFLICT, "approval is not pending (already resolved)")
    return {"data": decided}
