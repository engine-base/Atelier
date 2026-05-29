"""MCP トークン管理 サービス層 (T-A-08)。

token plaintext は secrets.token_urlsafe(32) で生成し sha256-hex (64 文字、DB
CHECK 制約準拠) を保存。応答で 1 度だけ plaintext を返す。
RLS:
  - select_member: workspace member 可視
  - insert_member: owner/member 投入可
  - delete_owner: owner のみ取消 (revoke) 可能
revoke は論理削除 (revoked_at セット)。状態変更で audit_logs 記録。
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.mcp_tokens import (
    McpTokenCreate,
    McpTokenCreateResponse,
    McpTokenResponse,
)

_COLS = (
    "id, workspace_id, name, scopes, expires_at, revoked_at, last_used_at, created_at, updated_at"
)


def _row_to_response(row: Any) -> McpTokenResponse:
    return McpTokenResponse(
        id=str(row.id),
        workspace_id=str(row.workspace_id),
        name=str(row.name),
        scopes=[str(s) for s in (row.scopes or [])],
        expires_at=row.expires_at,
        revoked_at=row.revoked_at,
        last_used_at=row.last_used_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _generate_token() -> tuple[str, str]:
    """plaintext (URL-safe) と sha256-hex hash を返す。"""
    plaintext = secrets.token_urlsafe(32)
    digest = hashlib.sha256(plaintext.encode("utf-8")).hexdigest()
    return plaintext, digest


async def list_tokens(
    session: AsyncSession,
    *,
    workspace_id: str | None = None,
    include_revoked: bool = False,
) -> list[McpTokenResponse]:
    where: list[str] = ["1=1"]
    params: dict[str, object] = {}
    if workspace_id is not None:
        where.append("workspace_id = cast(:wid as uuid)")
        params["wid"] = workspace_id
    if not include_revoked:
        where.append("revoked_at is null")
    res = await session.execute(
        text(
            f"select {_COLS} from public.mcp_tokens "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_token(session: AsyncSession, token_id: str) -> McpTokenResponse | None:
    res = await session.execute(
        text(f"select {_COLS} from public.mcp_tokens where id = cast(:id as uuid)"),
        {"id": token_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_token(
    session: AsyncSession, *, actor_id: str, data: McpTokenCreate
) -> McpTokenCreateResponse | None:
    """plaintext を生成し sha256-hex を DB 保存。応答で plaintext を 1 度だけ返す。"""
    plaintext, digest = _generate_token()
    new_id = str(uuid.uuid4())
    res = await session.execute(
        text(
            "insert into public.mcp_tokens "
            "(id, workspace_id, token_hash, name, scopes, expires_at) "
            "values (cast(:id as uuid), cast(:wid as uuid), :h, :n, "
            " cast(:sc as text[]), cast(:exp as timestamptz)) returning id"
        ),
        {
            "id": new_id,
            "wid": data.workspace_id,
            "h": digest,
            "n": data.name,
            "sc": data.scopes,
            "exp": data.expires_at,
        },
    )
    if res.scalar_one_or_none() is None:  # pragma: no cover - RLS 違反は通常 raise
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="mcp_token.create",
            target_type="mcp_token",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=data.workspace_id,
            target_id=new_id,
            after={"name": data.name, "scopes": data.scopes},
        )
    )
    created = await get_token(session, new_id)
    if created is None:  # pragma: no cover - 直前に作成済
        raise RuntimeError("created mcp_token not visible after insert")
    return McpTokenCreateResponse(**created.model_dump(), token=plaintext)


async def revoke_token(
    session: AsyncSession, *, actor_id: str, token_id: str
) -> McpTokenResponse | None:
    """revoke (revoked_at セット)。owner のみ実行可 (RLS delete_owner と同条件)。

    UPDATE は update_member (owner/member 共に可) だが、本 API ポリシーとして
    取消は owner 限定とする (ワークスペース level の信任に依る運用)。事前判定で
    403 を返せるようにする。
    """
    can_revoke = await session.execute(
        text(
            "select exists("
            " select 1 from public.mcp_tokens t "
            " join public.workspace_memberships m on m.workspace_id = t.workspace_id "
            " where t.id = cast(:id as uuid) and m.user_id = auth.uid() "
            " and m.role = 'owner')"
        ),
        {"id": token_id},
    )
    if not bool(can_revoke.scalar_one()):
        return None  # ルータで 403
    res = await session.execute(
        text(
            "update public.mcp_tokens set revoked_at = now() "
            "where id = cast(:id as uuid) and revoked_at is null returning id"
        ),
        {"id": token_id},
    )
    if res.scalar_one_or_none() is None:  # 既に revoked
        return await get_token(session, token_id)
    await AuditWriter(session).write(
        AuditEvent(
            action="mcp_token.revoke",
            target_type="mcp_token",
            actor_type="user",
            actor_id=actor_id,
            target_id=token_id,
        )
    )
    return await get_token(session, token_id)
