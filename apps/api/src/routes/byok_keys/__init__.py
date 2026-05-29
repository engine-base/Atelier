"""BYOK API キー管理ルータ (T-A-09)。

/byok/keys[/{id}]。認証 (401) + RLS (本人のみ) + 404。plaintext key は
登録時にしか受け取らず、応答に含めない (機密保持)。状態変更は audit_logs に記録。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.byok_keys import (
    ByokKeyCreate,
    ByokKeyResponse,
    ByokKeyUpdate,
    BYOKProvider,
)
from src.services import byok_keys as svc

router = APIRouter(tags=["byok-keys"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/byok/keys", summary="BYOK キー一覧（本人）")
async def list_keys(
    session: SessionDep,
    _user: UserDep,
    provider: Annotated[BYOKProvider | None, Query()] = None,
    include_inactive: Annotated[bool, Query()] = False,
) -> dict[str, list[ByokKeyResponse]]:
    return {
        "data": await svc.list_keys(session, provider=provider, include_inactive=include_inactive)
    }


@router.post(
    "/byok/keys",
    status_code=status.HTTP_201_CREATED,
    summary="BYOK キー登録（plaintext を暗号化保存、応答に含めない）",
)
async def create_key(
    body: ByokKeyCreate, session: SessionDep, user: UserDep
) -> dict[str, ByokKeyResponse]:
    created = await svc.create_key(session, actor_id=user.id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to create byok_key")
    return {"data": created}


@router.get("/byok/keys/{key_id}", summary="BYOK キー詳細（本人）")
async def get_key(key_id: str, session: SessionDep, _user: UserDep) -> dict[str, ByokKeyResponse]:
    item = await svc.get_key(session, key_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "byok_key not found")
    return {"data": item}


@router.patch("/byok/keys/{key_id}", summary="BYOK キー更新（label / is_active）")
async def update_key(
    key_id: str, body: ByokKeyUpdate, session: SessionDep, user: UserDep
) -> dict[str, ByokKeyResponse]:
    if await svc.get_key(session, key_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "byok_key not found")
    updated = await svc.update_key(session, actor_id=user.id, key_id=key_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update byok_key")
    return {"data": updated}


@router.delete(
    "/byok/keys/{key_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="BYOK キー削除（本人）",
)
async def delete_key(key_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_key(session, key_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "byok_key not found")
    if not await svc.delete_key(session, actor_id=user.id, key_id=key_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete byok_key")
