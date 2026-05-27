"""FastAPI 共有依存 (T-A-06)。

保護エンドポイント横断で使う:
  - get_current_user: Supabase JWT (HS256) をローカル検証し user_id を返す。
    署名検証は SUPABASE_JWT_SECRET で行い、Supabase Auth サービスへの往復は不要。
  - get_rls_session: RLS が効く AsyncSession を払い出す。接続単位で
    `set local role authenticated` + `request.jwt.claims` を投入し、
    per-entity RLS policy (T-D-14〜) を DB 側で enforce する。

外部 Supabase Auth に依存する signup/signin (T-A-01/02) とは独立しており、
本依存は JWT 検証のみで完結する (ローカル検証可能)。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory


class AuthSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ATELIER_AUTH_", env_file=".env", extra="ignore")
    jwt_secret: str = Field(
        default="",
        description="Supabase JWT 署名検証用 secret (HS256)。ATELIER_AUTH_JWT_SECRET",
    )


@lru_cache(maxsize=1)
def _auth_settings() -> AuthSettings:
    return AuthSettings()


@dataclass(frozen=True)
class CurrentUser:
    """検証済み JWT が表す認証ユーザー。"""

    id: str
    role: str
    claims: dict[str, object]


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def decode_supabase_jwt(token: str, secret: str, *, now: int | None = None) -> CurrentUser:
    """Supabase 形式 JWT (HS256) を検証して CurrentUser を返す。

    Raises:
        HTTPException(401): 形式不正 / 署名不一致 / 期限切れ / sub 欠落。
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "malformed token")
    header_b64, payload_b64, sig_b64 = parts

    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        provided = _b64url_decode(sig_b64)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "malformed signature") from exc
    if not hmac.compare_digest(expected, provided):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token signature")

    try:
        payload: dict[str, object] = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "malformed payload") from exc

    exp = payload.get("exp")
    current = int(time.time()) if now is None else now
    if isinstance(exp, int) and current >= exp:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token expired")

    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing sub claim")
    role = payload.get("role")
    return CurrentUser(
        id=sub,
        role=role if isinstance(role, str) else "authenticated",
        claims=payload,
    )


async def get_current_user(
    authorization: str | None = Header(default=None),
) -> CurrentUser:
    """Authorization: Bearer <jwt> を検証して CurrentUser を返す FastAPI 依存。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "missing bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization[len("bearer ") :].strip()
    secret = _auth_settings().jwt_secret
    if not secret:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "auth not configured")
    return decode_supabase_jwt(token, secret)


@lru_cache(maxsize=1)
def _engine() -> AsyncEngine:
    return create_engine()


@lru_cache(maxsize=1)
def _session_factory() -> async_sessionmaker[AsyncSession]:
    return create_session_factory(_engine())


async def get_rls_session(
    user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AsyncGenerator[AsyncSession, None]:
    """RLS が効く AsyncSession を払い出す。

    接続単位で role=authenticated + request.jwt.claims を投入し、per-entity RLS が
    auth.uid() = user.id として評価されるようにする。例外時 rollback、正常時 commit。
    """
    factory = _session_factory()
    claims = json.dumps({"sub": user.id, "role": user.role})
    async with factory() as session:
        # claims を先に設定 (superuser 権限のうちに) してから role を下げる。
        # いずれも transaction-local (true) — pooled connection 越しの漏洩を防ぐ。
        await session.execute(
            text("select set_config('request.jwt.claims', :claims, true)"),
            {"claims": claims},
        )
        await session.execute(text("set local role authenticated"))
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()
