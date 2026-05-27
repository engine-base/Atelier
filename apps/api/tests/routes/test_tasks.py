"""Integration tests for /tasks (T-A-26) — 実 Postgres + RLS + JWT。

user + workspace(owner) + project を seed し、その user の JWT で task CRUD +
受入条件取得を検証。get_current_user は本物、get_rls_session は NullPool override。
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
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta26-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            # owner membership は T-A-06 トリガが自動作成
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
class TestTasksCrud:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/tasks").status_code == 401

    def test_full_crud_and_enum_mapping(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "backend",
                    "title": "TA26 task",
                    "type": "feature",
                    "estimated_hours": 3,
                    "priority": "critical",
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            t = r.json()["data"]
            assert t["type"] == "feature"
            assert t["priority"] == "critical"  # 契約 (DB は urgent)
            assert t["lifecycle_stage"] == "triage"  # DB default
            tid = t["id"]

            assert any(
                x["id"] == tid
                for x in client.get(f"/tasks?project_id={seeded['proj_a']}", headers=h).json()[
                    "data"
                ]
            )
            assert client.get(f"/tasks/{tid}", headers=h).status_code == 200

            pr = client.patch(
                f"/tasks/{tid}",
                json={"lifecycle_stage": "in_progress", "priority": "low"},
                headers=h,
            )
            assert pr.status_code == 200
            assert pr.json()["data"]["lifecycle_stage"] == "in_progress"
            assert pr.json()["data"]["priority"] == "low"

            assert client.delete(f"/tasks/{tid}", headers=h).status_code == 204
            assert client.get(f"/tasks/{tid}", headers=h).status_code == 404

    def test_migration_type_maps_to_infrastructure(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "db",
                    "title": "migration task",
                    "type": "migration",
                    "estimated_hours": 2,
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            # 契約のみの 'migration' は DB の infrastructure に寄せて保存される
            assert r.json()["data"]["type"] == "infrastructure"
            client.delete(f"/tasks/{r.json()['data']['id']}", headers=h)

    def test_cross_workspace_task_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            tid = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "x",
                    "title": "A task",
                    "type": "feature",
                    "estimated_hours": 1,
                },
                headers=ha,
            ).json()["data"]["id"]
            assert client.get(f"/tasks/{tid}", headers=hb).status_code == 404
            client.delete(f"/tasks/{tid}", headers=ha)

    def test_acceptance_criteria(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "x",
                    "title": "AC task",
                    "type": "feature",
                    "estimated_hours": 1,
                },
                headers=h,
            ).json()["data"]["id"]
            # AC が無いうちは 404
            assert client.get(f"/tasks/{tid}/acceptance-criteria", headers=h).status_code == 404
            # service_role 相当 (superuser bypass) で AC を seed
            with sync_engine.begin() as c:
                c.execute(
                    text(
                        "insert into public.acceptance_criteria (task_id, html_path, items) "
                        "values (cast(:t as uuid), 'ac/path.html', cast(:items as jsonb))"
                    ),
                    {"t": tid, "items": json.dumps([{"tier": 1}])},
                )
            r = client.get(f"/tasks/{tid}/acceptance-criteria", headers=h)
            assert r.status_code == 200, r.text
            ac = r.json()["data"]
            assert ac["task_id"] == tid
            assert ac["items"] == [{"tier": 1}]
            client.delete(f"/tasks/{tid}", headers=h)

    def test_create_writes_audit_log(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "x",
                    "title": "Audited",
                    "type": "feature",
                    "estimated_hours": 1,
                },
                headers=h,
            ).json()["data"]["id"]
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='task.create' and target_id=:t"
                    ),
                    {"t": tid},
                ).scalar_one()
            assert n == 1
            client.delete(f"/tasks/{tid}", headers=h)


@pytest.mark.integration
class TestTaskExecutions:
    """T-A-27: タスク実行履歴・スコア取得 (read-only)。"""

    def _task(self, client: TestClient, seeded: dict[str, str]) -> str:
        return client.post(
            "/tasks",
            json={
                "project_id": seeded["proj_a"],
                "category": "backend",
                "title": "exec task",
                "type": "feature",
                "estimated_hours": 1,
            },
            headers=_h(seeded["u_a"]),
        ).json()["data"]["id"]

    def _seed_execution(self, sync_engine: sqlalchemy.Engine, task_id: str) -> str:
        """task_executions は dispatcher (service_role) が作るため superuser で seed。"""
        eid = str(uuid.uuid4())
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.task_executions "
                    "(id, task_id, started_at, completed_at, status, score, "
                    " ac_pass_rate, test_pass_rate, verification_score, retry_count) "
                    "values (cast(:i as uuid), cast(:t as uuid), now() - interval '5 min', "
                    " now(), 'succeeded', 0.95, 1.0, 0.9, 0.92, 1)"
                ),
                {"i": eid, "t": task_id},
            )
        return eid

    def test_executions_unauthenticated_401(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            tid = self._task(client, seeded)
            assert client.get(f"/tasks/{tid}/executions").status_code == 401
            client.delete(f"/tasks/{tid}", headers=_h(seeded["u_a"]))

    def test_list_and_get_execution_with_scores(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._task(client, seeded)
            eid = self._seed_execution(sync_engine, tid)

            lst = client.get(f"/tasks/{tid}/executions", headers=h)
            assert lst.status_code == 200, lst.text
            rows = lst.json()["data"]
            assert any(e["id"] == eid for e in rows)

            g = client.get(f"/tasks/{tid}/executions/{eid}", headers=h)
            assert g.status_code == 200
            d = g.json()["data"]
            assert d["status"] == "succeeded"
            assert d["score"] == 0.95
            assert d["ac_pass_rate"] == 1.0
            assert d["retry_count"] == 1
            client.delete(f"/tasks/{tid}", headers=h)

    def test_execution_not_found_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._task(client, seeded)
            assert (
                client.get(f"/tasks/{tid}/executions/{uuid.uuid4()}", headers=h).status_code == 404
            )
            # 不可視タスクの実行履歴は 404
            assert client.get(f"/tasks/{uuid.uuid4()}/executions", headers=h).status_code == 404
            client.delete(f"/tasks/{tid}", headers=h)

    def test_cross_workspace_executions_404(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            tid = self._task(client, seeded)
            self._seed_execution(sync_engine, tid)
            # 別 WS の user からはタスク自体が不可視 → 404
            assert client.get(f"/tasks/{tid}/executions", headers=hb).status_code == 404
            client.delete(f"/tasks/{tid}", headers=ha)
