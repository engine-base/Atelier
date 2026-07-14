"""x-rate-limit 契約 (openapi.yaml) の実装テスト — src/rate_limit.py。

- SlidingWindowLimiter の純ロジック (窓の滑り / Retry 秒)
- 実 route (POST /tasks/{id}/play, 10/min/user) で 11 回目に 429 + Retry-After
  が実際に返ること (L-006: 上限到達の実挙動 = 明示 4xx・500/破損にしない)

conftest が既定で ATELIER_RATE_LIMIT_DISABLED=1 を立てるため、本テストだけ
monkeypatch で解除し、limiter を都度 reset して分離する。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.rate_limit import SlidingWindowLimiter, limiter
from src.routes.tasks import router as tasks_router

JWT_SECRET = "test-rate-limit-secret"


def _mint_jwt(user_id: str) -> str:
    def b(x: bytes) -> bytes:
        return base64.urlsafe_b64encode(x).rstrip(b"=")

    h = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    p = b(
        json.dumps(
            {"sub": user_id, "role": "authenticated", "exp": int(time.time()) + 600}
        ).encode()
    )
    s = b(hmac.new(JWT_SECRET.encode(), h + b"." + p, hashlib.sha256).digest())
    return (h + b"." + p + b"." + s).decode()


# ── 純ロジック ────────────────────────────────────────────────────────────


def test_sliding_window_allows_then_rejects() -> None:
    lm = SlidingWindowLimiter()
    for _ in range(3):
        assert lm.check("k", times=3, per_seconds=60) is None
    retry = lm.check("k", times=3, per_seconds=60)
    assert retry is not None and 0 < retry <= 60


def test_sliding_window_recovers_after_window() -> None:
    lm = SlidingWindowLimiter()
    assert lm.check("k", times=1, per_seconds=0.05) is None
    assert lm.check("k", times=1, per_seconds=0.05) is not None
    time.sleep(0.06)
    assert lm.check("k", times=1, per_seconds=0.05) is None


def test_keys_are_isolated() -> None:
    lm = SlidingWindowLimiter()
    assert lm.check("a", times=1, per_seconds=60) is None
    assert lm.check("b", times=1, per_seconds=60) is None  # 別 key は独立
    assert lm.check("a", times=1, per_seconds=60) is not None


# ── 実 route 到達 (L-006) ────────────────────────────────────────────────


@pytest.fixture()
def app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setenv("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("ATELIER_RATE_LIMIT_DISABLED", "0")
    limiter.reset()
    a = FastAPI()
    a.include_router(tasks_router)
    return a


def test_play_route_returns_429_after_limit(app: FastAPI) -> None:
    """10/min/user: 11 回目で 429 + Retry-After (存在しない task でも依存が先に効く)。"""
    headers = {"Authorization": f"Bearer {_mint_jwt(str(uuid.uuid4()))}"}
    bogus = str(uuid.uuid4())
    with TestClient(app, raise_server_exceptions=False) as cl:
        codes = [cl.post(f"/tasks/{bogus}/play", headers=headers).status_code for _ in range(10)]
        # 上限内は rate limit では弾かれない (DB 未接続のため 500 だが 429 でないことが本質)
        assert all(c != 429 for c in codes), codes
        r11 = cl.post(f"/tasks/{bogus}/play", headers=headers)
    assert r11.status_code == 429
    assert int(r11.headers["Retry-After"]) >= 1


def test_play_route_limit_is_per_user(app: FastAPI) -> None:
    """別ユーザーは独立の窓を持つ (user A が上限でも user B は通る)。"""
    bogus = str(uuid.uuid4())
    ha = {"Authorization": f"Bearer {_mint_jwt(str(uuid.uuid4()))}"}
    hb = {"Authorization": f"Bearer {_mint_jwt(str(uuid.uuid4()))}"}
    with TestClient(app, raise_server_exceptions=False) as cl:
        for _ in range(10):
            cl.post(f"/tasks/{bogus}/play", headers=ha)
        assert cl.post(f"/tasks/{bogus}/play", headers=ha).status_code == 429
        assert cl.post(f"/tasks/{bogus}/play", headers=hb).status_code != 429


def test_disabled_flag_bypasses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)
    monkeypatch.setenv("ATELIER_RATE_LIMIT_DISABLED", "1")
    limiter.reset()
    a = FastAPI()
    a.include_router(tasks_router)
    headers = {"Authorization": f"Bearer {_mint_jwt(str(uuid.uuid4()))}"}
    bogus = str(uuid.uuid4())
    with TestClient(a, raise_server_exceptions=False) as cl:
        codes = [cl.post(f"/tasks/{bogus}/play", headers=headers).status_code for _ in range(12)]
    assert all(c != 429 for c in codes), codes
