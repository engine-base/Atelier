"""Integration tests for GET /ai-employees/{id}/activities (GAP-008) — 実 Postgres + RLS。

fixture は workspace 作成時の AI 社員自動シード (T-A-54 trigger) を前提にし、
社員を手動 insert しない (dev DB でもそのまま走る)。実 DB 無なら skip。
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
    """WS を作り、自動シードされた AI 社員 1 名に task/decision/execution/thread を紐付ける。"""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a, task_a = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"gap008-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        # 自動シード済み社員から 1 名選ぶ (手動 insert しない — dev DB trigger と両立)
        emp = c.execute(
            text(
                "select id from public.ai_employees where workspace_id = cast(:w as uuid) "
                "order by name limit 1"
            ),
            {"w": ws_a},
        ).scalar_one()
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
        c.execute(
            text(
                "insert into public.tasks (id, project_id, category, title, type, "
                "estimated_hours, priority, lifecycle_stage, assigned_employee_id) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', '活動タスク', "
                "'feature', 2, 'medium', 'done', cast(:e as uuid))"
            ),
            {"i": task_a, "p": proj_a, "e": str(emp)},
        )
        c.execute(
            text(
                "insert into public.decisions (project_id, status, body, decided_by) "
                "values (cast(:p as uuid), 'decided', '活動テスト決定', cast(:e as uuid))"
            ),
            {"p": proj_a, "e": str(emp)},
        )
        c.execute(
            text(
                "insert into public.task_executions (task_id, started_at, status, score) "
                "values (cast(:t as uuid), now(), 'succeeded', 0.9)"
            ),
            {"t": task_a},
        )
        c.execute(
            text(
                "insert into public.chat_threads (project_id, ai_employee_id, title) "
                "values (cast(:p as uuid), cast(:e as uuid), '活動スレッド')"
            ),
            {"p": proj_a, "e": str(emp)},
        )
    yield {"u_a": u_a, "u_b": u_b, "emp": str(emp), "proj_a": proj_a, "task_a": task_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestEmployeeActivities:
    def test_unauthenticated_401(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.get(f"/ai-employees/{seeded['emp']}/activities")
            assert r.status_code == 401

    def test_feed_unions_four_sources_desc(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.get(f"/ai-employees/{seeded['emp']}/activities", headers=_h(seeded["u_a"]))
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            types = {x["type"] for x in data}
            assert types == {"task", "decision", "execution", "thread"}
            # 新しい順
            ats = [x["at"] for x in data]
            assert ats == sorted(ats, reverse=True)
            ex = next(x for x in data if x["type"] == "execution")
            assert "succeeded" in (ex["detail"] or "")
            assert ex["title"] == "活動タスク"

    def test_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.get(f"/ai-employees/{seeded['emp']}/activities", headers=_h(seeded["u_b"]))
            assert r.status_code == 404  # 社員自体が不可視 (RLS)

    def test_not_found_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.get(f"/ai-employees/{uuid.uuid4()}/activities", headers=_h(seeded["u_a"]))
            assert r.status_code == 404
