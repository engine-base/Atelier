"""確定事項/未確認 (decisions) ルータ (T-D-101)。

/decisions[/{id}]。認証 (401) + RLS + 404。S-F01 確定事項/未確認タブの配線先。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.decisions import DecisionCreate, DecisionResponse, DecisionUpdate
from src.services import decisions as svc

router = APIRouter(tags=["decisions"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/decisions", summary="確定事項/未確認 一覧")
async def list_decisions(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    phase_id: Annotated[str | None, Query()] = None,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
) -> dict[str, list[DecisionResponse]]:
    return {
        "data": await svc.list_decisions(
            session, project_id=project_id, phase_id=phase_id, status=status_filter
        )
    }


@router.get("/decisions/{decision_id}", summary="確定事項 取得")
async def get_decision(
    decision_id: str, session: SessionDep, _user: UserDep
) -> dict[str, DecisionResponse]:
    dec = await svc.get_decision(session, decision_id)
    if dec is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "decision not found")
    return {"data": dec}


@router.post("/decisions", status_code=status.HTTP_201_CREATED, summary="確定事項 作成")
async def create_decision(
    body: DecisionCreate, session: SessionDep, _user: UserDep
) -> dict[str, DecisionResponse]:
    created = await svc.create_decision(session, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to create decision")
    return {"data": created}


@router.patch("/decisions/{decision_id}", summary="確定事項 更新 (状態遷移含む)")
async def update_decision(
    decision_id: str, body: DecisionUpdate, session: SessionDep, _user: UserDep
) -> dict[str, DecisionResponse]:
    if await svc.get_decision(session, decision_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "decision not found")
    updated = await svc.update_decision(session, decision_id=decision_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update decision")
    return {"data": updated}
