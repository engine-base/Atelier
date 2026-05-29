"""クライアント別 JWT signin + project view サービス層 (T-A-35 / R-T08 致命級)。

R-T08 (致命級・経営者承認済として実装): client_portal JWT は project_id を
claim に焼き込み、その project 以外には一切アクセスできない (越境完全分離)。

設計:
- invitation_token (plaintext) → sha256 → client_invitations.token_hash 照合
- 有効性検証: revoked_at is null かつ expires_at > now (期限切れは expired)
- client JWT: HS256 (ATELIER_AUTH_JWT_SECRET)、claims =
    sub = "client:" + invitation_id (実 user ではないと識別できる prefix)
    role = "client_portal"
    project_id = invitation.project_id
    invitation_id = invitation.id
    scopes = invitation.scopes
    aud = "client"
- project view: JWT の project_id claim と要求された path id が一致しなければ
  403 (R-T08 越境拒否)。DB アクセスは capability (署名済 JWT) を信頼源とし、
  service_role session で project_id 限定 SELECT する。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.db.session import create_engine, create_session_factory
from src.schemas.client_signin import (
    ClientProjectRef,
    ClientProjectView,
    ClientSigninResponse,
)

_CLIENT_TOKEN_TTL_SECONDS = 24 * 3600
"""client_portal JWT の TTL (24h)。"""

_CLIENT_ROLE = "client_portal"
_CLIENT_AUD = "client"


class ClientSigninError(Exception):
    """client signin / project view の構造的失敗。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@lru_cache(maxsize=1)
def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    return create_session_factory(create_engine())


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def _secret() -> str:
    s = os.environ.get("ATELIER_AUTH_JWT_SECRET")
    if not s:
        raise ClientSigninError("auth_not_configured", "ATELIER_AUTH_JWT_SECRET is not set")
    return s


def mint_client_token(
    *, invitation_id: str, project_id: str, scopes: list[str], now: int
) -> tuple[str, datetime]:
    """client_portal JWT を発行する (HS256)。"""
    exp = now + _CLIENT_TOKEN_TTL_SECONDS
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(
        json.dumps(
            {
                "sub": f"client:{invitation_id}",
                "role": _CLIENT_ROLE,
                "aud": _CLIENT_AUD,
                "project_id": project_id,
                "invitation_id": invitation_id,
                "scopes": scopes,
                "exp": exp,
            }
        ).encode()
    )
    sig = _b64url(
        hmac.new(_secret().encode(), f"{header}.{payload}".encode("ascii"), hashlib.sha256).digest()
    )
    return f"{header}.{payload}.{sig}", datetime.fromtimestamp(exp, tz=UTC)


def decode_client_token(token: str, *, now: int | None = None) -> dict[str, Any]:
    """client_portal JWT を検証して claims を返す。

    R-T08: role が client_portal でない / 署名不一致 / 期限切れ / project_id
    claim 欠落 は全て invalid_client_token として拒否する。
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise ClientSigninError("invalid_client_token", "malformed client token")
    header_b64, payload_b64, sig_b64 = parts
    expected = hmac.new(
        _secret().encode(), f"{header_b64}.{payload_b64}".encode("ascii"), hashlib.sha256
    ).digest()
    try:
        provided = _b64url_decode(sig_b64)
    except ValueError as exc:
        raise ClientSigninError("invalid_client_token", "malformed signature") from exc
    if not hmac.compare_digest(expected, provided):
        raise ClientSigninError("invalid_client_token", "invalid client token signature")
    try:
        payload: dict[str, Any] = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ClientSigninError("invalid_client_token", "malformed payload") from exc
    current = int(time.time()) if now is None else now
    exp = payload.get("exp")
    if isinstance(exp, int) and current >= exp:
        raise ClientSigninError("invalid_client_token", "client token expired")
    if payload.get("role") != _CLIENT_ROLE:
        raise ClientSigninError("invalid_client_token", "not a client_portal token")
    if not isinstance(payload.get("project_id"), str):
        raise ClientSigninError("invalid_client_token", "missing project_id claim")
    return payload


async def client_signin(
    *,
    invitation_token: str,
    display_name: str | None,
    ip_address: str | None,
) -> ClientSigninResponse:
    """招待トークンを引き換えに client_portal JWT を発行する。

    Raises ClientSigninError:
      - invalid_token: token_hash 不一致 / revoked (401)
      - expired: expires_at <= now (410)
    """
    token_hash = hashlib.sha256(invitation_token.encode("utf-8")).hexdigest()
    now_epoch = int(time.time())
    factory = _service_session_factory()
    async with factory() as session:
        try:
            res = await session.execute(
                text(
                    "select ci.id, ci.project_id, ci.scopes, ci.expires_at, "
                    "ci.revoked_at, ci.client_display_name, p.name as project_name "
                    "from public.client_invitations ci "
                    "join public.projects p on p.id = ci.project_id "
                    "where ci.token_hash = :h"
                ),
                {"h": token_hash},
            )
            row = res.first()
            if row is None or row.revoked_at is not None:
                raise ClientSigninError("invalid_token", "invalid invitation token")
            # 期限切れ判定
            expires_at = row.expires_at
            if expires_at is not None:
                exp_aware = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=UTC)
                if exp_aware <= datetime.now(UTC):
                    raise ClientSigninError("expired", "invitation token expired")

            scopes_raw = row.scopes
            if isinstance(scopes_raw, str):
                scopes = json.loads(scopes_raw)
            elif isinstance(scopes_raw, list):
                scopes = scopes_raw
            else:
                scopes = ["view"]
            scopes = [str(s) for s in scopes]

            invitation_id = str(row.id)
            project_id = str(row.project_id)

            # 初回使用なら used_at + display_name 補完
            await session.execute(
                text(
                    "update public.client_invitations set "
                    "used_at = coalesce(used_at, now()), "
                    "client_display_name = coalesce(client_display_name, :dn), "
                    "updated_at = now() "
                    "where id = cast(:i as uuid)"
                ),
                {"dn": display_name, "i": invitation_id},
            )
            await AuditWriter(session).write(
                AuditEvent(
                    action="client.signin",
                    target_type="client_invitation",
                    actor_type="anonymous",
                    actor_id=f"client:{invitation_id}",
                    target_id=invitation_id,
                    ip_address=_normalize_ip(ip_address),
                    after={"project_id": project_id, "scopes": scopes},
                )
            )
            token, token_exp = mint_client_token(
                invitation_id=invitation_id,
                project_id=project_id,
                scopes=scopes,
                now=now_epoch,
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise

    return ClientSigninResponse(
        client_access_token=token,
        token_type="bearer",
        expires_at=token_exp,
        project=ClientProjectRef(id=project_id, name=str(row.project_name)),
        scopes=scopes,
    )


def _normalize_ip(ip: str | None) -> str | None:
    import ipaddress

    if ip is None:
        return None
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return None
    return ip


async def get_client_project(
    *,
    claims: dict[str, Any],
    requested_project_id: str,
) -> ClientProjectView:
    """client_portal JWT で project を閲覧する。

    R-T08 越境拒否: JWT の project_id claim と requested_project_id が一致
    しなければ cross_project (403)。一致時のみ capability に基づき
    service_role session で当該 project を SELECT する。
    """
    claim_project_id = str(claims.get("project_id"))
    if claim_project_id != requested_project_id:
        raise ClientSigninError("cross_project", "client token is not authorized for this project")
    invitation_id = str(claims.get("invitation_id", ""))
    scopes_claim = claims.get("scopes")
    scopes = [str(s) for s in scopes_claim] if isinstance(scopes_claim, list) else []

    factory = _service_session_factory()
    async with factory() as session:
        res = await session.execute(
            text(
                "select p.id, p.name, p.client_name, "
                "ci.client_display_name "
                "from public.projects p "
                "left join public.client_invitations ci "
                "  on ci.id = cast(:inv as uuid) "
                "where p.id = cast(:pid as uuid) and p.deleted_at is null"
            ),
            {
                "inv": invitation_id or "00000000-0000-0000-0000-000000000000",
                "pid": requested_project_id,
            },
        )
        row = res.first()
    if row is None:
        raise ClientSigninError("project_not_found", "project not found")
    return ClientProjectView(
        id=str(row.id),
        name=str(row.name),
        description=(None if row.client_name is None else str(row.client_name)),
        scopes=scopes,
        viewed_as_client_display_name=(
            None if row.client_display_name is None else str(row.client_display_name)
        ),
    )
