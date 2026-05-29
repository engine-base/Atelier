"""DB-free unit tests for T-A-02 signin helpers.

CI Gate #4 環境では Postgres 不在で integration tests が skip される場合が
あるため、JWT mint / 失敗カウント / password 照合の純ロジックを stub
session で直接 exercise する。
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "unit-test-secret")

from src.services.auth import (
    SigninError,
    _count_recent_failures,
    _mint_access_token,
    _verify_password_local,
)


@dataclass
class _StubResult:
    value: Any = None
    rows: list[Any] | None = None

    def scalar_one(self) -> Any:
        return self.value

    def first(self) -> Any:
        return self.rows[0] if self.rows else None


class _StubSession:
    def __init__(self, responses: list[_StubResult]) -> None:
        self._responses = list(responses)

    async def execute(self, *_a: Any, **_k: Any) -> _StubResult:
        return self._responses.pop(0) if self._responses else _StubResult()


@pytest.fixture()
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


class TestMintAccessToken:
    def test_mint_produces_decodable_jwt(self, event_loop) -> None:
        from src.dependencies import decode_supabase_jwt

        uid = str(uuid.uuid4())
        now = int(time.time())
        token, expires_at = _mint_access_token(user_id=uid, now=now)
        assert len(token.split(".")) == 3
        cu = decode_supabase_jwt(token, os.environ["ATELIER_AUTH_JWT_SECRET"])
        assert cu.id == uid
        assert cu.role == "authenticated"
        assert expires_at.timestamp() > now

    def test_mint_without_secret_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ATELIER_AUTH_JWT_SECRET", raising=False)
        with pytest.raises(SigninError) as ei:
            _mint_access_token(user_id="x", now=int(time.time()))
        assert ei.value.code == "auth_not_configured"


class TestCountRecentFailures:
    def test_returns_int(self, event_loop) -> None:
        session = _StubSession([_StubResult(value=3)])
        result = event_loop.run_until_complete(
            _count_recent_failures(session, email="a@example.com")  # type: ignore[arg-type]
        )
        assert result == 3


class TestVerifyPasswordLocal:
    def test_correct_password_returns_uid(self, event_loop) -> None:
        @dataclass
        class _Row:
            id: str
            encrypted_password: str

        uid = str(uuid.uuid4())
        pw = "correct-pw"
        pw_hash = hashlib.sha256(pw.encode()).hexdigest()
        session = _StubSession([_StubResult(rows=[_Row(id=uid, encrypted_password=pw_hash)])])
        result = event_loop.run_until_complete(
            _verify_password_local(session, email="a@example.com", password=pw)  # type: ignore[arg-type]
        )
        assert result == uid

    def test_wrong_password_raises_invalid_credentials(self, event_loop) -> None:
        @dataclass
        class _Row:
            id: str
            encrypted_password: str

        pw_hash = hashlib.sha256(b"right").hexdigest()
        session = _StubSession([_StubResult(rows=[_Row(id="u", encrypted_password=pw_hash)])])
        with pytest.raises(SigninError) as ei:
            event_loop.run_until_complete(
                _verify_password_local(session, email="a@example.com", password="wrong")  # type: ignore[arg-type]
            )
        assert ei.value.code == "invalid_credentials"

    def test_unknown_user_raises_invalid_credentials(self, event_loop) -> None:
        session = _StubSession([_StubResult(rows=None)])
        with pytest.raises(SigninError) as ei:
            event_loop.run_until_complete(
                _verify_password_local(session, email="x@example.com", password="pw")  # type: ignore[arg-type]
            )
        assert ei.value.code == "invalid_credentials"
