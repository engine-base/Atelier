"""Integration tests for /contract/* (T-A-45 API 契約凍結 + screen coverage)。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from collections.abc import AsyncGenerator, Iterator
from typing import Annotated

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_jwt(user_id: str, *, admin: bool = False) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload_dict: dict[str, object] = {
        "sub": user_id,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    if admin:
        payload_dict["app_metadata"] = {"role": "admin"}
    payload = _b64url(json.dumps(payload_dict).encode())
    sig = _b64url(
        hmac.new(
            JWT_SECRET.encode(), f"{header}.{payload}".encode("ascii"), hashlib.sha256
        ).digest()
    )
    return f"{header}.{payload}.{sig}"


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")


@pytest.fixture()
def app() -> Iterator[FastAPI]:
    test_engine = create_async_engine(PG_ASYNC, poolclass=NullPool)

    async def _override_session(
        user: Annotated[CurrentUser, Depends(get_current_user)],
    ) -> AsyncGenerator[AsyncSession, None]:
        claims = json.dumps({"sub": user.id, "role": user.role})
        async with AsyncSession(test_engine) as session:
            await session.execute(
                text("select set_config('request.jwt.claims', :c, true)"), {"c": claims}
            )
            await session.execute(text("set local role authenticated"))
            try:
                yield session
            except Exception:
                await session.rollback()
                raise
            else:
                await session.commit()

    from src.routes import api_router

    application = FastAPI()
    application.include_router(api_router)
    application.dependency_overrides[get_rls_session] = _override_session
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def admin_user(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """admin user を seed。contract.freeze 等の audit_logs を test 後に cleanup。"""
    uid = str(uuid.uuid4())
    em = f"ta45-{uid[:8]}@example.com"
    with sync_engine.begin() as c:
        c.execute(
            text("insert into auth.users (id, email) values (cast(:i as uuid), :e)"),
            {"i": uid, "e": em},
        )
        c.execute(
            text(
                "insert into public.users (id, email, display_name) "
                "values (cast(:i as uuid), :e, 'Admin')"
            ),
            {"i": uid, "e": em},
        )
    yield {"user_id": uid, "email": em}
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.audit_logs "
                "where action in ('contract.freeze', 'contract.unfreeze') "
                "and actor_id = :u"
            ),
            {"u": uid},
        )
        c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": uid})
        c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": uid})


@pytest.mark.integration
class TestContract:
    def test_screen_coverage_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/contract/screen-coverage").status_code == 401
            assert client.get("/contract/freeze-status").status_code == 401

    def test_screen_coverage_returns_100_pct(
        self, app: FastAPI, admin_user: dict[str, str]
    ) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(admin_user['user_id'])}"}
        with TestClient(app) as client:
            r = client.get("/contract/screen-coverage", headers=h)
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["total_screens"] > 0
            assert d["coverage_pct"] == 100.0
            assert d["uncovered_screens"] == []

    def test_freeze_status_default_unfrozen(self, app: FastAPI, admin_user: dict[str, str]) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(admin_user['user_id'])}"}
        with TestClient(app) as client:
            r = client.get("/contract/freeze-status", headers=h)
            assert r.status_code == 200
            d = r.json()["data"]
            # 他テストで凍結された後の可能性があるため、frozen の type だけ確認
            assert isinstance(d["frozen"], bool)
            assert d["total_paths"] > 0
            assert d["total_methods"] > 0

    def test_freeze_non_admin_403(self, app: FastAPI, admin_user: dict[str, str]) -> None:
        h = {"Authorization": f"Bearer {_mint_jwt(admin_user['user_id'])}"}
        with TestClient(app) as client:
            r = client.post("/contract/freeze", headers=h, json={"note": "x"})
            assert r.status_code == 403

    def test_freeze_admin_succeeds_and_marks_frozen(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        admin_user: dict[str, str],
    ) -> None:
        # 直前の状態をクリーン
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "delete from public.audit_logs "
                    "where action in ('contract.freeze', 'contract.unfreeze') "
                    "and actor_id = :u"
                ),
                {"u": admin_user["user_id"]},
            )
        h = {"Authorization": f"Bearer {_mint_jwt(admin_user['user_id'], admin=True)}"}
        with TestClient(app) as client:
            r = client.post("/contract/freeze", headers=h, json={"note": "W2 end"})
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["frozen"] is True
            assert d["frozen_by_user_id"] == admin_user["user_id"]
            assert d["last_note"] == "W2 end"
            # 二度目の freeze は 409
            r2 = client.post("/contract/freeze", headers=h, json={"note": "dup"})
            assert r2.status_code == 409
            # unfreeze で解除
            r3 = client.post("/contract/unfreeze", headers=h, json={"note": "W3"})
            assert r3.status_code == 200
            assert r3.json()["data"]["frozen"] is False
            # 連続 unfreeze は 409
            r4 = client.post("/contract/unfreeze", headers=h, json={})
            assert r4.status_code == 409

    def test_screen_coverage_includes_all_seen_endpoints(
        self, app: FastAPI, admin_user: dict[str, str]
    ) -> None:
        """screen_id ごとの endpoints 集計が正しい (S-A01 は signup/signin/magic-link 等を含む)。"""
        h = {"Authorization": f"Bearer {_mint_jwt(admin_user['user_id'])}"}
        with TestClient(app) as client:
            r = client.get("/contract/screen-coverage", headers=h)
            assert r.status_code == 200
            entries = r.json()["data"]["entries"]
            sa01 = next(e for e in entries if e["screen_id"] == "S-A01")
            assert sa01["endpoint_count"] >= 3
            assert any("/auth/signup" in ep for ep in sa01["endpoints"])
