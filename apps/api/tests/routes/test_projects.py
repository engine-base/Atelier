"""Integration tests for /projects (T-A-10) — 実 Postgres + RLS + JWT。

workspace + owner membership を seed し、その user の JWT で project CRUD を検証。
get_current_user は本物、get_rls_session は NullPool テスト engine の override。
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
def seeded() -> Iterator[dict[str, str]]:
    """user A + workspace A (owner), user B + workspace B (owner)。"""
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    with eng.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta10-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            # owner membership は workspaces_bootstrap_owner_membership トリガ
            # (T-A-06) が自動作成するため、ここでは workspace のみ挿入する。
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "ws_b": ws_b}
    with eng.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
    eng.dispose()


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestProjectsCrud:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/projects").status_code == 401

    def test_full_crud_and_enum_mapping(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/projects",
                json={
                    "workspace_id": seeded["ws_a"],
                    "name": "TA10 proj",
                    "type": "self_product",
                    "description": "desc",
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            proj = r.json()["data"]
            assert proj["type"] == "self_product"  # 契約 enum (DB は internal_product)
            assert proj["status"] == "draft"
            assert proj["description"] == "desc"
            assert proj["ai_learning_opt_out"] is True  # F-LEGAL-011 デフォルト
            assert proj["current_phase"] == "hearing"
            pid = proj["id"]

            # list (workspace filter + meta)
            lr = client.get(f"/projects?workspace_id={seeded['ws_a']}", headers=h)
            assert lr.status_code == 200
            body = lr.json()
            assert any(p["id"] == pid for p in body["data"])
            assert body["meta"]["total_estimate"] >= 1

            assert client.get(f"/projects/{pid}", headers=h).status_code == 200

            # patch status in_progress (契約) → DB active
            pr = client.patch(f"/projects/{pid}", json={"status": "in_progress"}, headers=h)
            assert pr.status_code == 200
            assert pr.json()["data"]["status"] == "in_progress"

            assert client.delete(f"/projects/{pid}", headers=h).status_code == 204
            assert client.get(f"/projects/{pid}", headers=h).status_code == 404

    def test_dashboard(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            pid = client.post(
                "/projects",
                json={"workspace_id": seeded["ws_a"], "name": "Dash", "type": "personal"},
                headers=h,
            ).json()["data"]["id"]
            # task を 2 件作成 (lifecycle 既定 triage)
            for title in ("t1", "t2"):
                client.post(
                    "/tasks",
                    json={
                        "project_id": pid,
                        "category": "x",
                        "title": title,
                        "type": "feature",
                        "estimated_hours": 1,
                    },
                    headers=h,
                )
            r = client.get(f"/projects/{pid}/dashboard", headers=h)
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["project_id"] == pid
            assert d["task_counts"]["total"] == 2
            assert d["task_counts"]["triage"] == 2
            # project.create / task.create が activity に含まれる
            assert any(a["action"] == "task.create" for a in d["recent_activities"])
            client.delete(f"/projects/{pid}", headers=h)

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            pid = client.post(
                "/projects",
                json={"workspace_id": seeded["ws_a"], "name": "A proj", "type": "personal"},
                headers=ha,
            ).json()["data"]["id"]
            # user B は A の project を参照不可 (RLS → 404)
            assert client.get(f"/projects/{pid}", headers=hb).status_code == 404
            assert all(p["id"] != pid for p in client.get("/projects", headers=hb).json()["data"])
            client.delete(f"/projects/{pid}", headers=ha)

    def test_create_writes_audit_log(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            pid = client.post(
                "/projects",
                json={"workspace_id": seeded["ws_a"], "name": "Audited", "type": "personal"},
                headers=h,
            ).json()["data"]["id"]
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='project.create' and target_id=:t"
                    ),
                    {"t": pid},
                ).scalar_one()
            assert n == 1
            client.delete(f"/projects/{pid}", headers=h)
