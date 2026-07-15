"""Integration tests for /kanban/* (T-A-28) — 実 Postgres + Bridge token。

Bridge worker 用 7 ツールの HTTP layer。X-Bridge-Token 認証 (Supabase JWT
独立) + service_role セッション (RLS バイパス)。Hermes 互換 lifecycle / dispatch
遷移を実 DB で検証。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterator

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
BRIDGE_TOKEN = "test-bridge-token-secret"
os.environ["ATELIER_BRIDGE_TOKEN"] = BRIDGE_TOKEN
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

import sqlalchemy  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402


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
    # Bridge session は内部 factory 経由のため、test 用 engine を inject
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    test_engine = create_async_engine(PG_ASYNC, poolclass=NullPool)

    async def _override() -> object:
        async with AsyncSession(test_engine) as session:
            try:
                yield session
            except Exception:
                await session.rollback()
                raise
            else:
                await session.commit()

    from src.routes import api_router
    from src.routes.dispatcher import get_bridge_session

    application = FastAPI()
    application.include_router(api_router)
    application.dependency_overrides[get_bridge_session] = _override
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_a = str(uuid.uuid4())
    ws_a = str(uuid.uuid4())
    proj_a = str(uuid.uuid4())
    queued_id = str(uuid.uuid4())
    running_id = str(uuid.uuid4())
    with sync_engine.begin() as c:
        em = f"ta28-{u_a[:8]}@t.invalid"
        c.execute(
            text("insert into auth.users (id,email) values (:i,:e)"),
            {"i": u_a, "e": em},
        )
        c.execute(
            text("insert into public.users (id,email) values (:i,:e)"),
            {"i": u_a, "e": em},
        )
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws_a, "o": u_a, "n": "ws-a"},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
        # queued task: pick で取得対象
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, category, title, type, estimated_hours, priority, "
                "lifecycle_stage, dispatch_status) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', :t, "
                "'feature', 2, 'medium', 'in_progress', 'queued')"
            ),
            {"i": queued_id, "p": proj_a, "t": "queued"},
        )
        # running task: complete / request-review / kill 対象
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, category, title, type, estimated_hours, priority, "
                "lifecycle_stage, dispatch_status, worker_pid) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', :t, "
                "'feature', 2, 'medium', 'in_progress', 'running', 1234)"
            ),
            {"i": running_id, "p": proj_a, "t": "running"},
        )
    yield {
        "u_a": u_a,
        "ws_a": ws_a,
        "proj_a": proj_a,
        "queued_id": queued_id,
        "running_id": running_id,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id = :i"), {"i": ws_a})
        c.execute(text("delete from public.users where id = :i"), {"i": u_a})
        c.execute(text("delete from auth.users where id = :i"), {"i": u_a})


def _h(tok: str = BRIDGE_TOKEN) -> dict[str, str]:
    return {"X-Bridge-Token": tok}


def _seed_execution(eng: sqlalchemy.Engine, *, task_id: str) -> str:
    exec_id = str(uuid.uuid4())
    with eng.begin() as c:
        c.execute(
            text(
                "insert into public.task_executions "
                "(id, task_id, started_at, status) "
                "values (cast(:e as uuid), cast(:t as uuid), now(), 'running')"
            ),
            {"e": exec_id, "t": task_id},
        )
    return exec_id


@pytest.mark.integration
class TestKanbanTools:
    def test_missing_bridge_token_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post("/kanban/pick", json={"worker_pid": 1})
            assert r.status_code == 401

    def test_wrong_bridge_token_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/kanban/pick",
                headers=_h("wrong-token"),
                json={"worker_pid": 1},
            )
            assert r.status_code == 401

    def test_pick_returns_no_available_when_empty(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine
    ) -> None:
        # seeded fixture を使わず、queued task 無しの状態で pick
        with TestClient(app) as client:
            r = client.post(
                "/kanban/pick",
                headers=_h(),
                json={"worker_pid": 99, "project_id": str(uuid.uuid4())},
            )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["no_available_task"] is True

    def test_pick_claims_queued_task_atomically(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/kanban/pick",
                headers=_h(),
                json={"worker_pid": 5555, "project_id": seeded["proj_a"]},
            )
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            assert data["no_available_task"] is False
            assert data["task_id"] == seeded["queued_id"]
            assert data["execution_id"] is not None
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select dispatch_status, worker_pid from public.tasks "
                    "where id = cast(:i as uuid)"
                ),
                {"i": seeded["queued_id"]},
            ).first()
            assert row is not None
            assert str(row.dispatch_status) == "spawning"
            assert int(row.worker_pid) == 5555
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'kanban.pick' and target_id = cast(:t as uuid)"
                ),
                {"t": seeded["queued_id"]},
            ).scalar_one()
            assert cnt == 1

    def test_start_invalid_state_409(self, app: FastAPI, seeded: dict[str, str]) -> None:
        exec_id = str(uuid.uuid4())
        with TestClient(app) as client:
            r = client.post(
                "/kanban/start",
                headers=_h(),
                json={
                    "task_id": seeded["running_id"],
                    "execution_id": exec_id,
                    "worker_pid": 1234,
                },
            )
            # running task は start 不可 (dispatch_status='running')
            assert r.status_code == 409

    def test_complete_writes_metadata_and_executions(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        exec_id = _seed_execution(sync_engine, task_id=seeded["running_id"])
        with TestClient(app) as client:
            r = client.post(
                "/kanban/complete",
                headers=_h(),
                json={
                    "task_id": seeded["running_id"],
                    "execution_id": exec_id,
                    "summary": "完了サマリ",
                    "auto_approve": True,
                    "metadata": {
                        "score": 0.97,
                        "ac_pass_rate": 1.0,
                        "test_pass_rate": 0.95,
                        "verification_score": 0.96,
                        "retry_count": 0,
                        "files_changed": ["a.py", "b.py"],
                    },
                },
            )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["lifecycle_stage"] == "done"
        with sync_engine.begin() as c:
            tr = c.execute(
                text(
                    "select lifecycle_stage, dispatch_status from public.tasks "
                    "where id = cast(:i as uuid)"
                ),
                {"i": seeded["running_id"]},
            ).first()
            assert tr is not None
            assert str(tr.lifecycle_stage) == "done"
            assert str(tr.dispatch_status) == "completing"
            er = c.execute(
                text(
                    "select status, score from public.task_executions where id = cast(:e as uuid)"
                ),
                {"e": exec_id},
            ).first()
            assert er is not None
            assert str(er.status) == "succeeded"
            assert float(er.score) == pytest.approx(0.97)

    def test_complete_without_auto_approve_goes_to_awaiting(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        exec_id = _seed_execution(sync_engine, task_id=seeded["running_id"])
        with TestClient(app) as client:
            r = client.post(
                "/kanban/complete",
                headers=_h(),
                json={
                    "task_id": seeded["running_id"],
                    "execution_id": exec_id,
                    "summary": "レビュー待ち",
                    "auto_approve": False,
                    "metadata": {
                        "score": 0.99,
                        "ac_pass_rate": 1.0,
                        "test_pass_rate": 1.0,
                        "verification_score": 1.0,
                        "retry_count": 0,
                    },
                },
            )
            assert r.status_code == 200
            assert r.json()["data"]["lifecycle_stage"] == "awaiting"

    def test_request_change_moves_to_blocked_with_reason(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        exec_id = _seed_execution(sync_engine, task_id=seeded["running_id"])
        with TestClient(app) as client:
            r = client.post(
                "/kanban/request-change",
                headers=_h(),
                json={
                    "task_id": seeded["running_id"],
                    "execution_id": exec_id,
                    "reason": "AC が満たされていない",
                },
            )
            assert r.status_code == 200
            assert r.json()["data"]["lifecycle_stage"] == "blocked"
            # バグ #21 回帰: dispatch_status を running のまま残すと再 pick 不能で孤児化する
            assert r.json()["data"]["dispatch_status"] == "reclaimed"
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select blocked_reason, dispatch_status, worker_pid "
                    "from public.tasks where id = cast(:i as uuid)"
                ),
                {"i": seeded["running_id"]},
            ).first()
            assert row is not None
            assert "AC" in str(row.blocked_reason)
            assert str(row.dispatch_status) == "reclaimed"
            assert row.worker_pid is None

    def test_request_review_moves_to_awaiting(self, app: FastAPI, seeded: dict[str, str]) -> None:
        exec_id = str(uuid.uuid4())
        with TestClient(app) as client:
            r = client.post(
                "/kanban/request-review",
                headers=_h(),
                json={
                    "task_id": seeded["running_id"],
                    "execution_id": exec_id,
                    "note": "微妙な判断箇所あり",
                },
            )
            assert r.status_code == 200
            assert r.json()["data"]["lifecycle_stage"] == "awaiting"
            assert r.json()["data"]["action"] == "review_requested"

    def test_heartbeat_updates_timestamp(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/kanban/heartbeat",
                headers=_h(),
                json={"task_id": seeded["running_id"], "worker_pid": 1234},
            )
            assert r.status_code == 200
            assert r.json()["data"]["action"] == "heartbeat_ack"
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select worker_last_heartbeat_at from public.tasks where id = cast(:i as uuid)"
                ),
                {"i": seeded["running_id"]},
            ).first()
            assert row is not None and row.worker_last_heartbeat_at is not None

    def test_heartbeat_wrong_pid_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/kanban/heartbeat",
                headers=_h(),
                json={"task_id": seeded["running_id"], "worker_pid": 999},
            )
            assert r.status_code == 404

    def test_kill_reclaims_task(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        exec_id = _seed_execution(sync_engine, task_id=seeded["running_id"])
        with TestClient(app) as client:
            r = client.post(
                "/kanban/kill",
                headers=_h(),
                json={
                    "task_id": seeded["running_id"],
                    "execution_id": exec_id,
                    "reason": "deadlock detected",
                },
            )
            assert r.status_code == 200
            assert r.json()["data"]["dispatch_status"] == "reclaimed"
        with sync_engine.begin() as c:
            tr = c.execute(
                text(
                    "select dispatch_status, worker_pid from public.tasks "
                    "where id = cast(:i as uuid)"
                ),
                {"i": seeded["running_id"]},
            ).first()
            assert tr is not None
            assert str(tr.dispatch_status) == "reclaimed"
            assert tr.worker_pid is None
            er = c.execute(
                text("select status from public.task_executions where id = cast(:e as uuid)"),
                {"e": exec_id},
            ).first()
            assert er is not None
            assert str(er.status) == "cancelled"
