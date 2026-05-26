"""Unit tests for src.dependencies (T-A-06 共有認証/RLS 基盤)。

DB 不要。JWT 検証 (decode_supabase_jwt / get_current_user) と RLS session 払い出し
(get_rls_session) を、実 Postgres 無しで検証する。route 統合テスト (実 DB 必須) が
CI で skip されても本層のロジックがカバレッジ対象になるようにする。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import time
from typing import Any

import pytest
from fastapi import HTTPException

import src.dependencies as deps


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint(payload: dict[str, object], *, secret: str = "test-jwt-secret") -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = _b64url(json.dumps(payload).encode())
    sig = _b64url(
        hmac.new(secret.encode(), f"{header}.{body}".encode("ascii"), hashlib.sha256).digest()
    )
    return f"{header}.{body}.{sig}"


# --------------------------------------------------------------------------- #
# decode_supabase_jwt
# --------------------------------------------------------------------------- #
def test_decode_valid_returns_current_user() -> None:
    tok = _mint({"sub": "u-1", "role": "authenticated", "exp": int(time.time()) + 3600})
    user = deps.decode_supabase_jwt(tok, "test-jwt-secret")
    assert user.id == "u-1"
    assert user.role == "authenticated"
    assert user.claims["sub"] == "u-1"


def test_decode_role_defaults_to_authenticated() -> None:
    tok = _mint({"sub": "u-2", "exp": int(time.time()) + 3600})
    assert deps.decode_supabase_jwt(tok, "test-jwt-secret").role == "authenticated"


def test_decode_malformed_token() -> None:
    with pytest.raises(HTTPException) as ei:
        deps.decode_supabase_jwt("only.two", "test-jwt-secret")
    assert ei.value.status_code == 401


def test_decode_bad_signature() -> None:
    tok = _mint({"sub": "u", "exp": int(time.time()) + 3600}, secret="wrong-secret")
    with pytest.raises(HTTPException) as ei:
        deps.decode_supabase_jwt(tok, "test-jwt-secret")
    assert ei.value.status_code == 401


def test_decode_malformed_signature_b64() -> None:
    header = _b64url(json.dumps({"alg": "HS256"}).encode())
    body = _b64url(json.dumps({"sub": "u"}).encode())
    with pytest.raises(HTTPException) as ei:
        deps.decode_supabase_jwt(f"{header}.{body}.!!!bad", "test-jwt-secret")
    assert ei.value.status_code == 401


def test_decode_malformed_payload() -> None:
    header = _b64url(json.dumps({"alg": "HS256"}).encode())
    payload_b64 = _b64url(b"not-json")
    sig = _b64url(
        hmac.new(
            b"test-jwt-secret", f"{header}.{payload_b64}".encode("ascii"), hashlib.sha256
        ).digest()
    )
    with pytest.raises(HTTPException) as ei:
        deps.decode_supabase_jwt(f"{header}.{payload_b64}.{sig}", "test-jwt-secret")
    assert ei.value.status_code == 401


def test_decode_expired() -> None:
    tok = _mint({"sub": "u", "exp": 100})
    with pytest.raises(HTTPException) as ei:
        deps.decode_supabase_jwt(tok, "test-jwt-secret", now=200)
    assert ei.value.status_code == 401


def test_decode_missing_sub() -> None:
    tok = _mint({"role": "authenticated", "exp": int(time.time()) + 3600})
    with pytest.raises(HTTPException) as ei:
        deps.decode_supabase_jwt(tok, "test-jwt-secret")
    assert ei.value.status_code == 401


# --------------------------------------------------------------------------- #
# get_current_user
# --------------------------------------------------------------------------- #
def test_get_current_user_missing_header() -> None:
    with pytest.raises(HTTPException) as ei:
        asyncio.run(deps.get_current_user(authorization=None))
    assert ei.value.status_code == 401


def test_get_current_user_non_bearer() -> None:
    with pytest.raises(HTTPException) as ei:
        asyncio.run(deps.get_current_user(authorization="Basic abc"))
    assert ei.value.status_code == 401


def test_get_current_user_valid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        deps, "_auth_settings", lambda: deps.AuthSettings(jwt_secret="test-jwt-secret")
    )
    tok = _mint({"sub": "u-9", "role": "authenticated", "exp": int(time.time()) + 3600})
    user = asyncio.run(deps.get_current_user(authorization=f"Bearer {tok}"))
    assert user.id == "u-9"


def test_get_current_user_secret_not_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(deps, "_auth_settings", lambda: deps.AuthSettings(jwt_secret=""))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(deps.get_current_user(authorization="Bearer x.y.z"))
    assert ei.value.status_code == 500


def test_auth_settings_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_AUTH_JWT_SECRET", "from-env-secret")
    deps._auth_settings.cache_clear()
    try:
        assert deps._auth_settings().jwt_secret == "from-env-secret"
    finally:
        deps._auth_settings.cache_clear()


# --------------------------------------------------------------------------- #
# get_rls_session (fake session — DB 不要)
# --------------------------------------------------------------------------- #
class _FakeSession:
    def __init__(self) -> None:
        self.executed: list[Any] = []
        self.committed = False
        self.rolled_back = False

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def execute(self, statement: Any, params: Any = None) -> None:
        self.executed.append((str(statement), params))

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True


def _patch_factory(monkeypatch: pytest.MonkeyPatch, session: _FakeSession) -> None:
    monkeypatch.setattr(deps, "_session_factory", lambda: lambda: session)


def test_get_rls_session_commits_on_success(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession()
    _patch_factory(monkeypatch, session)
    user = deps.CurrentUser(id="u-1", role="authenticated", claims={})

    async def run() -> None:
        gen = deps.get_rls_session(user)
        s = await gen.__anext__()
        assert s is session
        with pytest.raises(StopAsyncIteration):
            await gen.__anext__()

    asyncio.run(run())
    # set_config(request.jwt.claims) + set local role authenticated の 2 文が流れる
    assert len(session.executed) == 2
    assert "set_config" in session.executed[0][0]
    assert session.executed[0][1] == {"claims": json.dumps({"sub": "u-1", "role": "authenticated"})}
    assert "authenticated" in session.executed[1][0]
    assert session.committed is True
    assert session.rolled_back is False


def test_get_rls_session_rolls_back_on_error(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession()
    _patch_factory(monkeypatch, session)
    user = deps.CurrentUser(id="u-2", role="authenticated", claims={})

    async def run() -> None:
        gen = deps.get_rls_session(user)
        await gen.__anext__()
        with pytest.raises(ValueError):
            await gen.athrow(ValueError("boom"))

    asyncio.run(run())
    assert session.rolled_back is True
    assert session.committed is False
