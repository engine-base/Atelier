"""工程ワークフロー (phases) ルータ (T-A-20)。

/workflow/phases[/{id}]。認証 (401) + RLS (T-D-21) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.workflow import PhaseCreate, PhaseResponse, PhaseUpdate
from src.services import workflow as svc

router = APIRouter(tags=["workflow"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/workflow/phases", summary="工程一覧")
async def list_phases(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
) -> dict[str, list[PhaseResponse]]:
    return {"data": await svc.list_phases(session, project_id=project_id)}


@router.post("/workflow/phases", status_code=status.HTTP_201_CREATED, summary="工程作成")
async def create_phase(
    body: PhaseCreate, session: SessionDep, user: UserDep
) -> dict[str, PhaseResponse]:
    return {"data": await svc.create_phase(session, actor_id=user.id, data=body)}


@router.get("/workflow/phases/{phase_id}", summary="工程詳細")
async def get_phase(phase_id: str, session: SessionDep, _user: UserDep) -> dict[str, PhaseResponse]:
    ph = await svc.get_phase(session, phase_id)
    if ph is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "phase not found")
    return {"data": ph}


@router.patch("/workflow/phases/{phase_id}", summary="工程遷移・更新")
async def update_phase(
    phase_id: str, body: PhaseUpdate, session: SessionDep, user: UserDep
) -> dict[str, PhaseResponse]:
    if await svc.get_phase(session, phase_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "phase not found")
    updated = await svc.update_phase(session, actor_id=user.id, phase_id=phase_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update phase")
    return {"data": updated}


@router.delete(
    "/workflow/phases/{phase_id}", status_code=status.HTTP_204_NO_CONTENT, summary="工程削除"
)
async def delete_phase(phase_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_phase(session, phase_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "phase not found")
    if not await svc.delete_phase(session, actor_id=user.id, phase_id=phase_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete phase")
