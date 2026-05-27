"""クライアント招待管理 ルータ (T-A-34)。

/client-invitations, /client-invitations/{id}, /client-invitations/{id}/revoke。
認証 (401) + RLS (T-A-34 migration: 所属 workspace の member のみ) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.client_invitations import (
    InvitationCreate,
    InvitationCreateResponse,
    InvitationResponse,
)
from src.services import client_invitations as svc

router = APIRouter(tags=["client-invitations"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/client-invitations", summary="クライアント招待一覧")
async def list_invitations(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
) -> dict[str, list[InvitationResponse]]:
    return {"data": await svc.list_invitations(session, project_id=project_id)}


@router.post(
    "/client-invitations", status_code=status.HTTP_201_CREATED, summary="クライアント招待作成"
)
async def create_invitation(
    body: InvitationCreate, session: SessionDep, user: UserDep
) -> dict[str, InvitationCreateResponse]:
    return {"data": await svc.create_invitation(session, actor_id=user.id, data=body)}


@router.get("/client-invitations/{invitation_id}", summary="クライアント招待詳細")
async def get_invitation(
    invitation_id: str, session: SessionDep, _user: UserDep
) -> dict[str, InvitationResponse]:
    inv = await svc.get_invitation(session, invitation_id)
    if inv is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invitation not found")
    return {"data": inv}


@router.post("/client-invitations/{invitation_id}/revoke", summary="クライアント招待失効")
async def revoke_invitation(
    invitation_id: str, session: SessionDep, user: UserDep
) -> dict[str, InvitationResponse]:
    if await svc.get_invitation(session, invitation_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "invitation not found")
    revoked = await svc.revoke_invitation(session, actor_id=user.id, invitation_id=invitation_id)
    if revoked is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "invitation already revoked")
    return {"data": revoked}
