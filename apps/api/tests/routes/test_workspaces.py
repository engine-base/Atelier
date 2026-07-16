"""Integration tests for /workspaces (T-A-06) — 実 Postgres + RLS + JWT。

ローカル Postgres (RLS migration 適用済) に接続し、Supabase 形式 JWT を mint して
TestClient で叩く。get_current_user (JWT 検証) は本物を使い、get_rls_session は
NullPool のテスト engine を使う override に差し替える (接続即クローズで
filterwarnings=error 下でも resource leak warning を出さない)。role=authenticated +
request.jwt.claims を投入するため RLS は本番同様に評価される。

実 DB が無い環境では skip。
"""

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
from fastapi import (  # noqa: E402
    Depends,
    FastAPI,
    HTTPException,
)
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import (  # noqa: E402
    CurrentUser,
    decode_supabase_jwt,
    get_current_user,
    get_rls_session,
)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_jwt(user_id: str) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(
        json.dumps(
            {
                "sub": user_id,
                "role": "authenticated",
                "aud": "authenticated",
                "exp": int(time.time()) + 3600,
            }
        ).encode()
    )
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
def seeded_users(sync_engine: sqlalchemy.Engine) -> Iterator[tuple[str, str]]:
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta06-{uid[:8]}@t.invalid"
            c.execute(
                text("insert into auth.users (id, email) values (:i,:e)"), {"i": uid, "e": em}
            )
            c.execute(
                text("insert into public.users (id, email) values (:i,:e)"), {"i": uid, "e": em}
            )
    yield u_a, u_b
    with sync_engine.begin() as c:
        # workspaces.owner_user_id は ON DELETE RESTRICT のため、soft-delete 済を含め
        # テスト workspace を hard-delete してから user を消す。
        c.execute(
            text("delete from public.workspaces where owner_user_id in (:a,:b)"),
            {"a": u_a, "b": u_b},
        )
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


@pytest.mark.unit
class TestJwtDecode:
    """decode_supabase_jwt / get_current_user の単体検証 (DB 不要)。"""

    def test_valid_token(self) -> None:
        uid = str(uuid.uuid4())
        cu = decode_supabase_jwt(_mint_jwt(uid), JWT_SECRET)
        assert cu.id == uid
        assert cu.role == "authenticated"

    def test_malformed_segments(self) -> None:
        with pytest.raises(HTTPException) as e:
            decode_supabase_jwt("only.two", JWT_SECRET)
        assert e.value.status_code == 401

    def test_bad_signature(self) -> None:
        with pytest.raises(HTTPException) as e:
            decode_supabase_jwt(_mint_jwt(str(uuid.uuid4())), "wrong-secret")
        assert e.value.status_code == 401

    def test_expired(self) -> None:
        token = _mint_jwt(str(uuid.uuid4()))
        with pytest.raises(HTTPException) as e:
            decode_supabase_jwt(token, JWT_SECRET, now=int(time.time()) + 99999)
        assert e.value.status_code == 401

    def test_missing_sub(self) -> None:
        header = _b64url(json.dumps({"alg": "HS256"}).encode())
        payload = _b64url(json.dumps({"role": "authenticated"}).encode())
        sig = _b64url(
            hmac.new(
                JWT_SECRET.encode(), f"{header}.{payload}".encode("ascii"), hashlib.sha256
            ).digest()
        )
        with pytest.raises(HTTPException) as e:
            decode_supabase_jwt(f"{header}.{payload}.{sig}", JWT_SECRET)
        assert e.value.status_code == 401

    def test_malformed_payload(self) -> None:
        header = _b64url(json.dumps({"alg": "HS256"}).encode())
        payload = _b64url(b"not-json{{")
        sig = _b64url(
            hmac.new(
                JWT_SECRET.encode(), f"{header}.{payload}".encode("ascii"), hashlib.sha256
            ).digest()
        )
        with pytest.raises(HTTPException) as e:
            decode_supabase_jwt(f"{header}.{payload}.{sig}", JWT_SECRET)
        assert e.value.status_code == 401

    @pytest.mark.asyncio
    async def test_get_current_user_missing_header(self) -> None:
        with pytest.raises(HTTPException) as e:
            await get_current_user(authorization=None)
        assert e.value.status_code == 401

    @pytest.mark.asyncio
    async def test_get_current_user_non_bearer(self) -> None:
        with pytest.raises(HTTPException) as e:
            await get_current_user(authorization="Basic abc")
        assert e.value.status_code == 401

    @pytest.mark.asyncio
    async def test_get_current_user_valid(self) -> None:
        uid = str(uuid.uuid4())
        cu = await get_current_user(authorization=f"Bearer {_mint_jwt(uid)}")
        assert cu.id == uid


@pytest.mark.integration
class TestWorkspacesCrud:
    def test_unauthenticated_returns_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/workspaces").status_code == 401

    def test_create_list_get_update_delete(
        self, app: FastAPI, seeded_users: tuple[str, str]
    ) -> None:
        u_a, _ = seeded_users
        h = {"Authorization": f"Bearer {_mint_jwt(u_a)}"}
        with TestClient(app) as client:
            r = client.post(
                "/workspaces", json={"name": "TA06 WS", "description": "hello"}, headers=h
            )
            assert r.status_code == 201, r.text
            ws = r.json()["data"]
            assert ws["name"] == "TA06 WS"
            assert ws["description"] == "hello"
            assert ws["member_count"] == 1
            wid = ws["id"]

            assert any(w["id"] == wid for w in client.get("/workspaces", headers=h).json()["data"])
            assert client.get(f"/workspaces/{wid}", headers=h).status_code == 200

            r = client.patch(f"/workspaces/{wid}", json={"name": "TA06 renamed"}, headers=h)
            assert r.status_code == 200
            assert r.json()["data"]["name"] == "TA06 renamed"

            assert client.delete(f"/workspaces/{wid}", headers=h).status_code == 204
            assert client.get(f"/workspaces/{wid}", headers=h).status_code == 404

    def test_create_bootstraps_ai_employees_from_templates(
        self, app: FastAPI, seeded_users: tuple[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """T-A-54 / ギャップ#27: WS 作成でアクティブテンプレから AI 社員が自動シードされる。"""
        u_a, _ = seeded_users
        h = {"Authorization": f"Bearer {_mint_jwt(u_a)}"}
        # 決定論のため一意名のテスト用テンプレを 2 件投入 (他テンプレ有無に非依存)
        marker = uuid.uuid4().hex[:8]
        names = [f"ta54emp1_{marker}", f"ta54emp2_{marker}"]
        with sync_engine.begin() as c:
            for i, nm in enumerate(names):
                c.execute(
                    text(
                        "insert into public.ai_employee_templates "
                        "(default_name, default_display_name, department, role, "
                        "system_prompt, specialty, version, is_active) values "
                        "(:n, :d, 'sales', 'member', 'sp', 'sc', :v, true)"
                    ),
                    {"n": nm, "d": f"表示{i}", "v": i + 1},
                )
        with TestClient(app) as client:
            wid = client.post("/workspaces", json={"name": f"TA54 {marker}"}, headers=h).json()[
                "data"
            ]["id"]
            emps = client.get(f"/ai-employees?workspace_id={wid}", headers=h).json()["data"]
            seeded = {e["name"] for e in emps}
            assert set(names).issubset(seeded), f"auto-seed 漏れ: {names} not in {seeded}"
            # is_default=True で実体化される
            assert all(e["template_id"] is not None for e in emps if e["name"] in names)
            client.delete(f"/workspaces/{wid}", headers=h)

    def test_cross_user_workspace_invisible_404(
        self, app: FastAPI, seeded_users: tuple[str, str]
    ) -> None:
        u_a, u_b = seeded_users
        ha = {"Authorization": f"Bearer {_mint_jwt(u_a)}"}
        hb = {"Authorization": f"Bearer {_mint_jwt(u_b)}"}
        with TestClient(app) as client:
            wid = client.post("/workspaces", json={"name": "A only"}, headers=ha).json()["data"][
                "id"
            ]
            assert client.get(f"/workspaces/{wid}", headers=hb).status_code == 404
            assert all(w["id"] != wid for w in client.get("/workspaces", headers=hb).json()["data"])
            client.delete(f"/workspaces/{wid}", headers=ha)

    def test_create_writes_audit_log(
        self, app: FastAPI, seeded_users: tuple[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        u_a, _ = seeded_users
        ha = {"Authorization": f"Bearer {_mint_jwt(u_a)}"}
        with TestClient(app) as client:
            wid = client.post("/workspaces", json={"name": "Audited"}, headers=ha).json()["data"][
                "id"
            ]
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='workspace.create' and target_id=:t"
                    ),
                    {"t": wid},
                ).scalar_one()
            assert n == 1
            client.delete(f"/workspaces/{wid}", headers=ha)
