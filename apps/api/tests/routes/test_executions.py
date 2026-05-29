"""Integration tests for /executions, /bridge/status (T-A-30) — 実 Postgres + RLS + JWT。

E-013 task_executions 横断一覧 + Bridge worker 集約状態。401 / 404 /
cross-workspace / filter / pagination / bridge counts を網羅。
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
    proj_a, proj_b = str(uuid.uuid4()), str(uuid.uuid4())
    task_running = str(uuid.uuid4())
    task_done = str(uuid.uuid4())
    task_cross = str(uuid.uuid4())
    exec_running = str(uuid.uuid4())
    exec_done = str(uuid.uuid4())
    exec_cross = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta30-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        for pid, ws in ((proj_a, ws_a), (proj_b, ws_b)):
            c.execute(
                text(
                    "insert into public.projects (id,workspace_id,name,project_type) "
                    "values (:i,:w,'p','internal_product')"
                ),
                {"i": pid, "w": ws},
            )
        # ws_a side: running + done tasks
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, category, title, type, estimated_hours, priority, "
                "lifecycle_stage, dispatch_status, worker_pid) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', 'running task', "
                "'feature', 2, 'medium', 'in_progress', 'running', 1111)"
            ),
            {"i": task_running, "p": proj_a},
        )
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, category, title, type, estimated_hours, priority, "
                "lifecycle_stage, dispatch_status) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', 'done task', "
                "'feature', 2, 'medium', 'done', 'completing')"
            ),
            {"i": task_done, "p": proj_a},
        )
        # ws_b 側 task (cross-workspace invisibility 検証)
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, category, title, type, estimated_hours, priority, "
                "lifecycle_stage, dispatch_status, worker_pid) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', 'cross task', "
                "'feature', 2, 'medium', 'in_progress', 'running', 2222)"
            ),
            {"i": task_cross, "p": proj_b},
        )
        # task_executions
        c.execute(
            text(
                "insert into public.task_executions "
                "(id, task_id, started_at, status) "
                "values (cast(:i as uuid), cast(:t as uuid), "
                "now() - interval '10 minutes', 'running')"
            ),
            {"i": exec_running, "t": task_running},
        )
        c.execute(
            text(
                "insert into public.task_executions "
                "(id, task_id, started_at, completed_at, status, score, ac_pass_rate, "
                "test_pass_rate, verification_score) "
                "values (cast(:i as uuid), cast(:t as uuid), "
                "now() - interval '20 minutes', now() - interval '15 minutes', "
                "'succeeded', 0.95, 1.0, 0.9, 0.95)"
            ),
            {"i": exec_done, "t": task_done},
        )
        c.execute(
            text(
                "insert into public.task_executions "
                "(id, task_id, started_at, status) "
                "values (cast(:i as uuid), cast(:t as uuid), now(), 'running')"
            ),
            {"i": exec_cross, "t": task_cross},
        )
    yield {
        "u_a": u_a,
        "u_b": u_b,
        "ws_a": ws_a,
        "ws_b": ws_b,
        "proj_a": proj_a,
        "proj_b": proj_b,
        "task_running": task_running,
        "task_done": task_done,
        "task_cross": task_cross,
        "exec_running": exec_running,
        "exec_done": exec_done,
        "exec_cross": exec_cross,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestExecutionsMonitor:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/executions").status_code == 401
            assert client.get(f"/executions/{uuid.uuid4()}").status_code == 401
            assert client.get("/bridge/status").status_code == 401

    def test_list_only_own_workspace(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get("/executions", headers=h)
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert seeded["exec_running"] in ids
            assert seeded["exec_done"] in ids
            # R-T08: ws_b の execution は見えない
            assert seeded["exec_cross"] not in ids

    def test_filter_by_status_running(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get("/executions?status=running", headers=h)
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert seeded["exec_running"] in ids
            assert seeded["exec_done"] not in ids

    def test_filter_by_task_id(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/executions?task_id={seeded['task_done']}", headers=h)
            assert r.status_code == 200
            data = r.json()["data"]
            assert len(data) == 1
            assert data[0]["id"] == seeded["exec_done"]
            assert data[0]["status"] == "succeeded"
            assert data[0]["score"] == pytest.approx(0.95)

    def test_pagination_limit_offset(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r1 = client.get("/executions?limit=1&offset=0", headers=h)
            assert r1.status_code == 200
            assert len(r1.json()["data"]) == 1
            r2 = client.get("/executions?limit=1&offset=1", headers=h)
            assert r2.status_code == 200
            # offset 0 と 1 で異なる execution
            if r2.json()["data"]:
                assert r2.json()["data"][0]["id"] != r1.json()["data"][0]["id"]

    def test_get_execution_includes_join_fields(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/executions/{seeded['exec_running']}", headers=h)
            assert r.status_code == 200
            d = r.json()["data"]
            assert d["task_title"] == "running task"
            assert d["worker_pid"] == 1111
            assert d["dispatch_status"] == "running"
            assert d["duration_seconds"] is not None
            assert d["duration_seconds"] > 0

    def test_get_execution_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha = _h(seeded["u_a"])
        with TestClient(app) as client:
            # ws_b の execution は ws_a user から見えない (R-T08)
            assert client.get(f"/executions/{seeded['exec_cross']}", headers=ha).status_code == 404

    def test_get_execution_404_for_nonexistent(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert client.get(f"/executions/{uuid.uuid4()}", headers=h).status_code == 404

    def test_bridge_status_counts(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get("/bridge/status", headers=h)
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            # ws_a only (RLS で ws_b は除外)
            assert d["running_count"] >= 1
            assert d["completing_count"] >= 1
            assert d["parallel_limit"] == 5
            assert d["available_slots"] == max(0, 5 - d["running_count"])
            assert 1111 in d["active_worker_pids"]
            # ws_b の worker_pid 2222 は cross-workspace で除外
            assert 2222 not in d["active_worker_pids"]
            assert d["oldest_running_started_at"] is not None

    def test_filter_by_project_id(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/executions?project_id={seeded['proj_a']}", headers=h)
            assert r.status_code == 200
            data = r.json()["data"]
            assert all(x["project_id"] == seeded["proj_a"] for x in data)
            assert any(x["id"] == seeded["exec_running"] for x in data)
