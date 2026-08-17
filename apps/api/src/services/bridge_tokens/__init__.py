"""GAP-122: ユーザー別 Bridge 接続トークン サービス層。

各ユーザーが自分の Bridge (PC アプリ) を接続するためのトークンを
発行・失効する。raw トークンは保存しない (sha256 hash のみ —
client_invitations と同方針)。発行応答で 1 度だけ raw を返す。

権限モデル (v1):
    - user トークンで許可: chat-relay (本人の job のみ) + bridge/ping
    - タスク実行系 (kanban/*) はインスタンス トークン限定
      (ユーザー トークンに過剰権限を与えない)
"""

from __future__ import annotations

import hashlib
import secrets
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("ascii")).hexdigest()


async def _audit(session: AsyncSession, *, action: str, actor_id: str, target_id: str) -> None:
    await AuditWriter(session).write(
        AuditEvent(
            action=action,
            target_type="bridge_user_token",
            actor_type="user",
            actor_id=actor_id,
            target_id=target_id,
        )
    )


async def issue_token(session: AsyncSession, *, user_id: str, label: str) -> dict[str, Any]:
    """トークンを発行し raw を 1 度だけ返す (以後は hash 照合のみ)。"""
    raw = secrets.token_urlsafe(32)
    res = await session.execute(
        text(
            "insert into public.bridge_user_tokens (user_id, token_hash, label) "
            "values (cast(:u as uuid), :h, :l) returning id, created_at"
        ),
        {"u": user_id, "h": _hash(raw), "l": label},
    )
    row = res.one()
    token_id = str(row.id)
    await _audit(session, action="bridge_token.issue", actor_id=user_id, target_id=token_id)
    return {"id": token_id, "token": raw, "label": label, "created_at": row.created_at}


async def list_tokens(session: AsyncSession, *, user_id: str) -> list[dict[str, Any]]:
    """本人のトークン一覧 (raw/hash は返さない)。"""
    res = await session.execute(
        text(
            "select id, label, created_at, last_used_at, revoked_at "
            "from public.bridge_user_tokens where user_id = cast(:u as uuid) "
            "order by created_at desc"
        ),
        {"u": user_id},
    )
    return [
        {
            "id": str(r.id),
            "label": str(r.label),
            "created_at": r.created_at,
            "last_used_at": r.last_used_at,
            "revoked_at": r.revoked_at,
        }
        for r in res.all()
    ]


async def revoke_token(session: AsyncSession, *, user_id: str, token_id: str) -> bool:
    """本人のトークンを失効する (他人のトークンは対象外 = False)。冪等。"""
    res = await session.execute(
        text(
            "update public.bridge_user_tokens set revoked_at = coalesce(revoked_at, now()) "
            "where id = cast(:i as uuid) and user_id = cast(:u as uuid) returning id"
        ),
        {"i": token_id, "u": user_id},
    )
    hit = res.first() is not None
    if hit:
        await _audit(session, action="bridge_token.revoke", actor_id=user_id, target_id=token_id)
    return hit


async def verify_user_token(session: AsyncSession, *, raw: str) -> str | None:
    """raw トークンを照合し、有効なら user_id を返す (last_used_at を更新)。"""
    res = await session.execute(
        text(
            "update public.bridge_user_tokens set last_used_at = now() "
            "where token_hash = :h and revoked_at is null "
            "returning user_id"
        ),
        {"h": _hash(raw)},
    )
    row = res.first()
    return None if row is None else str(row.user_id)
