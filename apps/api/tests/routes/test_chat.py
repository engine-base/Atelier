"""Integration tests for /chat/threads (T-A-16) — 実 Postgres + RLS + JWT。

user + workspace(owner) + project + ai_employee を seed し thread CRUD を検証。
実 DB 無なら skip。
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
    proj_a, emp_a = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta16-{uid[:8]}@t.invalid"
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
        c.execute(
            text(
                "insert into public.ai_employees (id,workspace_id,name,display_name,role,department) "
                "values (cast(:i as uuid),cast(:w as uuid),'tony','トニー','lead','sales')"
            ),
            {"i": emp_a, "w": ws_a},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "proj_a": proj_a, "emp_a": emp_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestChatThreads:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/chat/threads").status_code == 401

    def test_crud_and_archive(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/chat/threads",
                json={
                    "project_id": seeded["proj_a"],
                    "ai_employee_id": seeded["emp_a"],
                    "title": "T1",
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            th = r.json()["data"]
            assert th["archived"] is False
            tid = th["id"]

            assert any(
                x["id"] == tid
                for x in client.get(
                    f"/chat/threads?project_id={seeded['proj_a']}", headers=h
                ).json()["data"]
            )
            assert client.get(f"/chat/threads/{tid}", headers=h).status_code == 200

            # archive
            pr = client.patch(f"/chat/threads/{tid}", json={"archived": True}, headers=h)
            assert pr.status_code == 200
            assert pr.json()["data"]["archived"] is True
            # archived は既定一覧から除外、include_archived で出る
            assert all(
                x["id"] != tid
                for x in client.get(
                    f"/chat/threads?project_id={seeded['proj_a']}", headers=h
                ).json()["data"]
            )
            assert any(
                x["id"] == tid
                for x in client.get(
                    f"/chat/threads?project_id={seeded['proj_a']}&include_archived=true", headers=h
                ).json()["data"]
            )

            assert client.delete(f"/chat/threads/{tid}", headers=h).status_code == 204
            assert client.get(f"/chat/threads/{tid}", headers=h).status_code == 404

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            tid = client.post(
                "/chat/threads",
                json={"project_id": seeded["proj_a"], "ai_employee_id": seeded["emp_a"]},
                headers=ha,
            ).json()["data"]["id"]
            assert client.get(f"/chat/threads/{tid}", headers=hb).status_code == 404
            client.delete(f"/chat/threads/{tid}", headers=ha)
