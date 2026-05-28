"""MCP トークン管理 ルータ (T-A-08)。

/mcp-tokens[/{id}]。認証 (401) + RLS (T-D-21) + 404/403。
create は plaintext token を 1 度だけ返す (再表示不可)。revoke は owner のみ。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.mcp_tokens import (
    McpTokenCreate,
    McpTokenCreateResponse,
    McpTokenResponse,
)
from src.services import mcp_tokens as svc

router = APIRouter(tags=["mcp-tokens"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/mcp-tokens", summary="MCP トークン一覧")
async def list_tokens(
    session: SessionDep,
    _user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
    include_revoked: Annotated[bool, Query()] = False,
) -> dict[str, list[McpTokenResponse]]:
    return {
        "data": await svc.list_tokens(
            session, workspace_id=workspace_id, include_revoked=include_revoked
        )
    }


@router.post(
    "/mcp-tokens",
    status_code=status.HTTP_201_CREATED,
    summary="MCP トークン発行（plaintext を 1 度だけ返す）",
)
async def create_token(
    body: McpTokenCreate, session: SessionDep, user: UserDep
) -> dict[str, McpTokenCreateResponse]:
    created = await svc.create_token(session, actor_id=user.id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to create mcp_token")
    return {"data": created}


@router.get("/mcp-tokens/{token_id}", summary="MCP トークン詳細")
async def get_token(
    token_id: str, session: SessionDep, _user: UserDep
) -> dict[str, McpTokenResponse]:
    item = await svc.get_token(session, token_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mcp_token not found")
    return {"data": item}


@router.delete(
    "/mcp-tokens/{token_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="MCP トークン取消（owner のみ）",
)
async def revoke_token(token_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_token(session, token_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mcp_token not found")
    result = await svc.revoke_token(session, actor_id=user.id, token_id=token_id)
    if result is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "owner role required to revoke mcp_token")
