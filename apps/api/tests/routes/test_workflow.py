"""Integration tests for /workflow/phases (T-A-20) — 実 Postgres + RLS + JWT。実 DB 無なら skip。"""

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
            em = f"ta20-{uid[:8]}@t.invalid"
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
                "insert into public.projects (id,workspace_id,name,project_type) values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "proj_a": proj_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestWorkflowPhases:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/workflow/phases").status_code == 401

    def test_crud_and_transition(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/workflow/phases",
                json={"project_id": seeded["proj_a"], "order": 0, "name": "hearing"},
                headers=h,
            )
            assert r.status_code == 201, r.text
            ph = r.json()["data"]
            assert ph["status"] == "pending"
            assert ph["started_at"] is None
            pid = ph["id"]

            assert any(
                x["id"] == pid
                for x in client.get(
                    f"/workflow/phases?project_id={seeded['proj_a']}", headers=h
                ).json()["data"]
            )
            assert client.get(f"/workflow/phases/{pid}", headers=h).status_code == 200

            # 遷移 → in_progress で started_at 自動セット
            pr = client.patch(f"/workflow/phases/{pid}", json={"status": "in_progress"}, headers=h)
            assert pr.status_code == 200
            assert pr.json()["data"]["status"] == "in_progress"
            assert pr.json()["data"]["started_at"] is not None
            # → completed で completed_at セット
            cr = client.patch(f"/workflow/phases/{pid}", json={"status": "completed"}, headers=h)
            assert cr.json()["data"]["completed_at"] is not None

            assert client.delete(f"/workflow/phases/{pid}", headers=h).status_code == 204
            assert client.get(f"/workflow/phases/{pid}", headers=h).status_code == 404

    def test_seed_default_phases_and_idempotent(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/workflow/phases/seed", json={"project_id": seeded["proj_a"]}, headers=h
            )
            assert r.status_code == 201, r.text
            data = r.json()["data"]
            # 9 工程が order 1..9 で作られる
            assert len(data) == 9
            assert [p["order"] for p in data] == list(range(1, 10))
            assert [p["name"] for p in data] == [
                "ヒアリング",
                "要件定義",
                "アーキ設計",
                "デザイン",
                "機能分解",
                "タスク分解",
                "実装",
                "検証",
                "納品",
            ]
            # 先頭のみ in_progress + started_at、残りは pending
            assert data[0]["status"] == "in_progress"
            assert data[0]["started_at"] is not None
            assert all(p["status"] == "pending" for p in data[1:])
            assert all(p["started_at"] is None for p in data[1:])

            # 冪等: 2 回目でも重複せず 9 件のまま
            r2 = client.post(
                "/workflow/phases/seed", json={"project_id": seeded["proj_a"]}, headers=h
            )
            assert r2.status_code == 201, r2.text
            data2 = r2.json()["data"]
            assert len(data2) == 9
            assert {p["id"] for p in data2} == {p["id"] for p in data}

            # cleanup
            for p in data:
                client.delete(f"/workflow/phases/{p['id']}", headers=h)

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            pid = client.post(
                "/workflow/phases",
                json={"project_id": seeded["proj_a"], "order": 1, "name": "design"},
                headers=ha,
            ).json()["data"]["id"]
            assert client.get(f"/workflow/phases/{pid}", headers=hb).status_code == 404
            client.delete(f"/workflow/phases/{pid}", headers=ha)
