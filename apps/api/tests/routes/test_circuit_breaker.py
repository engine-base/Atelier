"""Integration tests for /admin/circuit-breaker/* (T-A-29) — 実 Postgres + admin JWT。

サーキットブレーカ評価 (failure_rate × 時間窓) + PID ポーリング (stale
running task 回収)。admin 限定 (403)、未認証 401、reset/poll の audit
記録、dry_run の副作用無しを検証。
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
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    admin_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    stale_task = str(uuid.uuid4())
    fresh_task = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (admin_id, user_id):
            em = f"ta29-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws, "o": admin_id, "n": "ws-a"},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,'p','internal_product')"
            ),
            {"i": proj, "w": ws},
        )
        # stale: 5 分前に heartbeat
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, category, title, type, estimated_hours, priority, "
                "lifecycle_stage, dispatch_status, worker_pid, worker_last_heartbeat_at, updated_at) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', :t, "
                "'feature', 2, 'medium', 'in_progress', 'running', 1234, "
                "now() - interval '5 minutes', now())"
            ),
            {"i": stale_task, "p": proj, "t": "stale"},
        )
        c.execute(
            text(
                "insert into public.task_executions "
                "(task_id, started_at, status) "
                "values (cast(:t as uuid), now() - interval '5 minutes', 'running')"
            ),
            {"t": stale_task},
        )
        # fresh: 直近 heartbeat
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, category, title, type, estimated_hours, priority, "
                "lifecycle_stage, dispatch_status, worker_pid, worker_last_heartbeat_at) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', :t, "
                "'feature', 2, 'medium', 'in_progress', 'running', 5678, now())"
            ),
            {"i": fresh_task, "p": proj, "t": "fresh"},
        )
    yield {
        "admin_id": admin_id,
        "user_id": user_id,
        "ws": ws,
        "proj": proj,
        "stale_task": stale_task,
        "fresh_task": fresh_task,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id = :i"), {"i": ws})
        c.execute(
            text("delete from public.users where id in (:a,:b)"), {"a": admin_id, "b": user_id}
        )
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": admin_id, "b": user_id})


def _h(uid: str, *, admin: bool = False) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid, admin=admin)}"}


@pytest.mark.integration
class TestCircuitBreaker:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/admin/circuit-breaker").status_code == 401
            assert (
                client.post("/admin/circuit-breaker/reset", json={"reason": "x"}).status_code == 401
            )
            assert client.post("/admin/circuit-breaker/poll-pids", json={}).status_code == 401

    def test_non_admin_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["user_id"], admin=False)
        with TestClient(app) as client:
            assert client.get("/admin/circuit-breaker", headers=h).status_code == 403

    def test_get_breaker_returns_state(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["admin_id"], admin=True)
        with TestClient(app) as client:
            r = client.get("/admin/circuit-breaker", headers=h)
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            assert data["state"] in ("closed", "open", "half_open")
            assert "failure_rate" in data
            assert data["window_minutes"] == 15

    def test_reset_writes_audit(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["admin_id"], admin=True)
        with TestClient(app) as client:
            r = client.post(
                "/admin/circuit-breaker/reset",
                headers=h,
                json={"reason": "post-incident review"},
            )
            assert r.status_code == 200, r.text
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'circuit_breaker.reset' "
                    "and actor_id = :a"
                ),
                {"a": seeded["admin_id"]},
            ).scalar_one()
            assert cnt == 1

    def test_poll_pids_dry_run_no_side_effect(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["admin_id"], admin=True)
        with TestClient(app) as client:
            r = client.post(
                "/admin/circuit-breaker/poll-pids",
                headers=h,
                json={"heartbeat_threshold_seconds": 60, "dry_run": True},
            )
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            assert data["stale_task_count"] >= 1
            stale_ids = {x["task_id"] for x in data["results"]}
            assert seeded["stale_task"] in stale_ids
            assert seeded["fresh_task"] not in stale_ids
            assert all(x["action"] == "dry_run_would_reclaim" for x in data["results"])
        # DB は変更されていない
        with sync_engine.begin() as c:
            row = c.execute(
                text("select dispatch_status from public.tasks where id = cast(:t as uuid)"),
                {"t": seeded["stale_task"]},
            ).first()
            assert row is not None and str(row.dispatch_status) == "running"

    def test_poll_pids_reclaims_and_audits(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["admin_id"], admin=True)
        with TestClient(app) as client:
            r = client.post(
                "/admin/circuit-breaker/poll-pids",
                headers=h,
                json={"heartbeat_threshold_seconds": 60, "dry_run": False},
            )
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            assert any(
                x["task_id"] == seeded["stale_task"] and x["action"] == "reclaimed"
                for x in data["results"]
            )
        # DB が更新されている
        with sync_engine.begin() as c:
            tr = c.execute(
                text(
                    "select dispatch_status, worker_pid, blocked_reason "
                    "from public.tasks where id = cast(:t as uuid)"
                ),
                {"t": seeded["stale_task"]},
            ).first()
            assert tr is not None
            assert str(tr.dispatch_status) == "reclaimed"
            assert tr.worker_pid is None
            assert "timeout" in str(tr.blocked_reason)
            # task_executions が timeout に
            ex = c.execute(
                text(
                    "select status from public.task_executions "
                    "where task_id = cast(:t as uuid) order by started_at desc limit 1"
                ),
                {"t": seeded["stale_task"]},
            ).first()
            assert ex is not None and str(ex.status) == "timeout"
            # audit ログ
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'circuit_breaker.pid_reclaim' "
                    "and target_id = cast(:t as uuid)"
                ),
                {"t": seeded["stale_task"]},
            ).scalar_one()
            assert cnt == 1

    def test_poll_pids_validates_threshold_range(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["admin_id"], admin=True)
        with TestClient(app) as client:
            assert (
                client.post(
                    "/admin/circuit-breaker/poll-pids",
                    headers=h,
                    json={"heartbeat_threshold_seconds": 5},
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/admin/circuit-breaker/poll-pids",
                    headers=h,
                    json={"heartbeat_threshold_seconds": 99999},
                ).status_code
                == 422
            )

    def test_get_breaker_validates_threshold(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["admin_id"], admin=True)
        with TestClient(app) as client:
            assert client.get("/admin/circuit-breaker?threshold=1.5", headers=h).status_code == 422
