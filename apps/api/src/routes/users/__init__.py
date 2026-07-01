"""自己プロフィール（/me）ルータ — T-UC-37。

認証ユーザー自身のプロフィール取得/更新。401（未認証）+ 404（users 行不在）。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.users import MeResponse, MeUpdate
from src.services import users as svc

router = APIRouter(tags=["users"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/me", summary="自己プロフィール取得")
async def get_me(session: SessionDep, user: UserDep) -> dict[str, MeResponse]:
    me = await svc.get_me(session, user.id)
    if me is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    return {"data": me}


@router.patch("/me", summary="自己プロフィール更新（display_name）")
async def update_me(body: MeUpdate, session: SessionDep, user: UserDep) -> dict[str, MeResponse]:
    updated = await svc.update_me(session, user_id=user.id, display_name=body.display_name)
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    return {"data": updated}
