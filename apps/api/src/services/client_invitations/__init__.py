"""クライアント招待管理 サービス層 (T-A-34)。

RLS が効く AsyncSession を受け取り client_invitations を操作する。可視性/権限は
RLS (T-A-34 migration: 所属 workspace の project の招待を member が CRUD)。
token は raw を生成時のみ返し、DB には SHA-256 hash を保存。状態変更で audit_logs。
"""

from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.client_invitations import (
    InvitationCreate,
    InvitationCreateResponse,
    InvitationResponse,
)

_COLS = (
    "id, project_id, email, scopes, expires_at, used_at, revoked_at, "
    "client_display_name, created_at, updated_at"
)


def _scopes(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        loaded: Any = json.loads(value)
        return [str(x) for x in loaded] if isinstance(loaded, list) else []
    if isinstance(value, list):
        return [str(x) for x in value]
    return []


def _row_to_response(row: Any) -> InvitationResponse:
    return InvitationResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        email=str(row.email),
        scopes=_scopes(row.scopes),
        expires_at=row.expires_at,
        used_at=row.used_at,
        revoked_at=row.revoked_at,
        client_display_name=(
            None if row.client_display_name is None else str(row.client_display_name)
        ),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_invitations(
    session: AsyncSession, *, project_id: str | None = None
) -> list[InvitationResponse]:
    where = ["1=1"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    res = await session.execute(
        text(
            f"select {_COLS} from public.client_invitations "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_invitation(session: AsyncSession, invitation_id: str) -> InvitationResponse | None:
    res = await session.execute(
        text(f"select {_COLS} from public.client_invitations where id = cast(:id as uuid)"),
        {"id": invitation_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_invitation(
    session: AsyncSession, *, actor_id: str, data: InvitationCreate
) -> InvitationCreateResponse:
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.client_invitations "
            "(id, project_id, email, token_hash, scopes, expires_at, client_display_name) "
            "values (cast(:id as uuid), cast(:pid as uuid), :email, :th, "
            "        cast(:scopes as jsonb), now() + make_interval(days => :ttl), :cdn)"
        ),
        {
            "id": new_id,
            "pid": data.project_id,
            "email": data.email,
            "th": token_hash,
            "scopes": json.dumps(data.scopes),
            "ttl": data.ttl_days,
            "cdn": data.client_display_name,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="client_invitation.create",
            target_type="client_invitation",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"email": data.email, "project_id": data.project_id},
        )
    )
    created = await get_invitation(session, new_id)
    if created is None:  # pragma: no cover
        raise RuntimeError("created invitation not visible after insert")
    return InvitationCreateResponse(**created.model_dump(), token=raw_token)


async def revoke_invitation(
    session: AsyncSession, *, actor_id: str, invitation_id: str
) -> InvitationResponse | None:
    res = await session.execute(
        text(
            "update public.client_invitations set revoked_at = now() "
            "where id = cast(:id as uuid) and revoked_at is null returning id"
        ),
        {"id": invitation_id},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="client_invitation.revoke",
            target_type="client_invitation",
            actor_type="user",
            actor_id=actor_id,
            target_id=invitation_id,
        )
    )
    return await get_invitation(session, invitation_id)
