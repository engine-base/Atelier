"""Integration tests for /mocks (T-A-33) — 実 Postgres + RLS + JWT。

user + workspace(owner) + project を seed し、mock CRUD + バージョン管理を検証。
get_current_user は本物、get_rls_session は NullPool override。実 DB 無なら skip。
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
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402


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
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta33-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "ws_b": ws_b, "proj_a": proj_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestMocksCrud:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/mocks").status_code == 401

    def test_full_crud(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-LOGIN",
                    "html_storage_path": "mocks/login-v1.html",
                    "meta_tags": {"k": "v"},
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            m = r.json()["data"]
            assert m["version"] == 1
            assert m["parent_mock_id"] is None
            assert m["meta_tags"] == {"k": "v"}
            mid = m["id"]

            assert any(
                x["id"] == mid
                for x in client.get(f"/mocks?project_id={seeded['proj_a']}", headers=h).json()[
                    "data"
                ]
            )
            assert client.get(f"/mocks/{mid}", headers=h).status_code == 200

            pr = client.patch(
                f"/mocks/{mid}", json={"html_storage_path": "mocks/login-v1b.html"}, headers=h
            )
            assert pr.status_code == 200
            assert pr.json()["data"]["html_storage_path"] == "mocks/login-v1b.html"

            assert client.delete(f"/mocks/{mid}", headers=h).status_code == 204
            assert client.get(f"/mocks/{mid}", headers=h).status_code == 404

    def test_version_chain(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            v1 = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-HOME",
                    "html_storage_path": "mocks/home-v1.html",
                },
                headers=h,
            ).json()["data"]
            assert v1["version"] == 1

            r2 = client.post(
                f"/mocks/{v1['id']}/versions",
                json={"html_storage_path": "mocks/home-v2.html"},
                headers=h,
            )
            assert r2.status_code == 201, r2.text
            v2 = r2.json()["data"]
            assert v2["version"] == 2
            assert v2["parent_mock_id"] == v1["id"]

            # 履歴は v1, v2 を version 昇順で返す
            hist = client.get(f"/mocks/{v1['id']}/versions", headers=h).json()["data"]
            assert [h_["version"] for h_ in hist] == [1, 2]
            client.delete(f"/mocks/{v2['id']}", headers=h)
            client.delete(f"/mocks/{v1['id']}", headers=h)

    def test_cross_workspace_mock_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            mid = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-X",
                    "html_storage_path": "x.html",
                },
                headers=ha,
            ).json()["data"]["id"]
            assert client.get(f"/mocks/{mid}", headers=hb).status_code == 404
            client.delete(f"/mocks/{mid}", headers=ha)

    def test_create_writes_audit_log(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            mid = client.post(
                "/mocks",
                json={
                    "project_id": seeded["proj_a"],
                    "screen_name": "S-AUD",
                    "html_storage_path": "a.html",
                },
                headers=h,
            ).json()["data"]["id"]
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='mock.create' and target_id=:t"
                    ),
                    {"t": mid},
                ).scalar_one()
            assert n == 1
            client.delete(f"/mocks/{mid}", headers=h)
