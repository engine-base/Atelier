"""GAP-122: ユーザー別 Bridge 接続トークン ルータ。

POST /bridge-tokens          — 発行 (raw は応答で 1 度だけ)
GET  /bridge-tokens          — 本人の一覧 (raw/hash なし)
POST /bridge-tokens/{id}/revoke — 失効 (本人のみ・冪等)

書き込みは service session (RLS default deny のため)。所有チェックは
where user_id = 本人 で行う (他人のトークン id は 404)。
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.session import shared_session_factory
from src.dependencies import CurrentUser, get_current_user
from src.schemas.bridge_tokens import (
    BridgeTokenCreate,
    BridgeTokenCreated,
    BridgeTokenRow,
)
from src.services import bridge_tokens as svc

router = APIRouter(tags=["bridge-tokens"])


async def _service_session() -> AsyncGenerator[AsyncSession, None]:
    """service session (RLS バイパス — 書き込みは所有チェック付き SQL のみ)。"""
    # GAP-197: engine はプロセスに 1 つ (モジュール変数で持つと loop を跨いで壊れる)
    async with shared_session_factory()() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()


ServiceSession = Annotated[AsyncSession, Depends(_service_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.post(
    "/bridge-tokens",
    status_code=status.HTTP_201_CREATED,
    summary="Bridge 接続トークン発行 (GAP-122 — raw は 1 度だけ返す)",
)
async def create_bridge_token(
    body: BridgeTokenCreate, session: ServiceSession, user: UserDep
) -> dict[str, BridgeTokenCreated]:
    created = await svc.issue_token(session, user_id=user.id, label=body.label or "Bridge")
    return {"data": BridgeTokenCreated(**created)}


@router.get("/bridge-tokens", summary="Bridge 接続トークン一覧 (本人のみ)")
async def list_bridge_tokens(
    session: ServiceSession, user: UserDep
) -> dict[str, list[BridgeTokenRow]]:
    rows = await svc.list_tokens(session, user_id=user.id)
    return {"data": [BridgeTokenRow(**r) for r in rows]}


@router.post("/bridge-tokens/{token_id}/revoke", summary="Bridge 接続トークン失効 (本人のみ)")
async def revoke_bridge_token(
    token_id: str, session: ServiceSession, user: UserDep
) -> dict[str, bool]:
    ok = await svc.revoke_token(session, user_id=user.id, token_id=token_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の接続トークンが見つかりません。")
    return {"data": True}
