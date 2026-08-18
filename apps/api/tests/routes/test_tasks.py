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
            # 契約 Task.dependencies/prerequisites/blocks は必須フィールド
            # (design-audit: 実装が返しておらず S-I02 依存タブが空になる契約違反だった)
            assert t["dependencies"] == []
            assert t["prerequisites"] == []
            assert t["blocks"] == []
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


@pytest.mark.integration
class TestTaskBulkAndDecision:
    """T-A-25: タスク一括再生 + 承認/差戻/再試行。"""

    def _create_task(
        self,
        client: TestClient,
        h: dict[str, str],
        proj_id: str,
        title: str,
    ) -> str:
        return client.post(
            "/tasks",
            json={
                "project_id": proj_id,
                "category": "backend",
                "title": title,
                "type": "feature",
                "estimated_hours": 1,
            },
            headers=h,
        ).json()["data"]["id"]

    def test_bulk_lifecycle_transitions_multiple_and_audit(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            t1 = self._create_task(client, h, seeded["proj_a"], "bulk-1")
            t2 = self._create_task(client, h, seeded["proj_a"], "bulk-2")
            r = client.post(
                "/tasks/bulk/lifecycle",
                json={
                    "task_ids": [t1, t2],
                    "target_stage": "in_progress",
                    "note": "kick off",
                },
                headers=h,
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["requested"] == 2
            assert d["updated"] == 2
            assert set(d["updated_task_ids"]) == {t1, t2}
            assert d["skipped_task_ids"] == []
            # 個別 task の lifecycle が反映
            assert (
                client.get(f"/tasks/{t1}", headers=h).json()["data"]["lifecycle_stage"]
                == "in_progress"
            )
        # audit_logs に 2 件 (task.bulk_lifecycle、各 task ごと)
        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='task.bulk_lifecycle' and target_id in "
                    "(cast(:t1 as uuid), cast(:t2 as uuid))"
                ),
                {"t1": t1, "t2": t2},
            ).scalar_one()
        assert n == 2

    def test_bulk_lifecycle_cross_workspace_skipped(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            t_visible = self._create_task(client, ha, seeded["proj_a"], "visible")
            fake_other = str(uuid.uuid4())
            # u_b (別 WS) が呼ぶ → t_visible は不可視で skipped、fake_other も skipped
            r = client.post(
                "/tasks/bulk/lifecycle",
                json={
                    "task_ids": [t_visible, fake_other],
                    "target_stage": "ready",
                },
                headers=hb,
            )
            assert r.status_code == 200
            d = r.json()["data"]
            assert d["updated"] == 0
            assert set(d["skipped_task_ids"]) == {t_visible, fake_other}

    def test_bulk_lifecycle_empty_422(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/tasks/bulk/lifecycle",
                json={"task_ids": [], "target_stage": "ready"},
                headers=h,
            )
            assert r.status_code == 422

    def test_approve_awaiting_to_done(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._create_task(client, h, seeded["proj_a"], "approve-me")
            # まず awaiting へ
            client.patch(f"/tasks/{tid}", json={"lifecycle_stage": "awaiting"}, headers=h)
            r = client.post(f"/tasks/{tid}/approve", json={"note": "ok"}, headers=h)
            assert r.status_code == 200
            assert r.json()["data"]["lifecycle_stage"] == "done"

    def test_approve_non_awaiting_409(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._create_task(client, h, seeded["proj_a"], "triage-only")
            # 既定は triage → approve できない
            assert client.post(f"/tasks/{tid}/approve", json={}, headers=h).status_code == 409

    def test_reject_awaiting_to_blocked_with_reason(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._create_task(client, h, seeded["proj_a"], "reject-me")
            client.patch(f"/tasks/{tid}", json={"lifecycle_stage": "awaiting"}, headers=h)
            r = client.post(
                f"/tasks/{tid}/reject",
                json={"note": "missing requirements"},
                headers=h,
            )
            assert r.status_code == 200
            d = r.json()["data"]
            assert d["lifecycle_stage"] == "blocked"
            assert d["blocked_reason"] == "missing requirements"

    def test_retry_blocked_increments_count(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._create_task(client, h, seeded["proj_a"], "retry-me")
            client.patch(f"/tasks/{tid}", json={"lifecycle_stage": "blocked"}, headers=h)
            r = client.post(f"/tasks/{tid}/retry", json={"note": "try again"}, headers=h)
            assert r.status_code == 200
            d = r.json()["data"]
            assert d["lifecycle_stage"] == "ready"
            assert d["retry_count"] == 1
            assert d["blocked_reason"] is None

    def test_retry_non_blocked_409(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._create_task(client, h, seeded["proj_a"], "no-retry")
            # 既定 triage → retry できない
            assert client.post(f"/tasks/{tid}/retry", json={}, headers=h).status_code == 409

    def test_decision_not_found_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            fake = uuid.uuid4()
            assert client.post(f"/tasks/{fake}/approve", json={}, headers=h).status_code == 404
            assert client.post(f"/tasks/{fake}/reject", json={}, headers=h).status_code == 404
            assert client.post(f"/tasks/{fake}/retry", json={}, headers=h).status_code == 404

    def test_decision_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            fake = uuid.uuid4()
            assert client.post(f"/tasks/{fake}/approve", json={}).status_code == 401
            assert (
                client.post(
                    "/tasks/bulk/lifecycle", json={"task_ids": [str(fake)], "target_stage": "ready"}
                ).status_code
                == 401
            )


# --------------------------------------------------------------------------- #
# T-A-24: タスク再生 API (/tasks/{id}/play) 単体テスト
# --------------------------------------------------------------------------- #
def _seed_task(
    eng: sqlalchemy.Engine,
    *,
    project_id: str,
    lifecycle: str = "ready",
    title: str = "playable",
    deps: list[str] | None = None,
) -> str:
    tid = str(uuid.uuid4())
    with eng.begin() as c:
        c.execute(
            text(
                "insert into public.tasks "
                "(id, project_id, category, title, type, estimated_hours, priority, "
                "lifecycle_stage, dependencies) "
                "values (cast(:i as uuid), cast(:p as uuid), 'misc', :t, "
                "'feature', 2, 'medium', "
                "cast(:ls as task_lifecycle_enum), :dp)"
            ),
            {
                "i": tid,
                "p": project_id,
                "t": title,
                "ls": lifecycle,
                "dp": deps or [],
            },
        )
    return tid


@pytest.mark.integration
class TestTaskPlay:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert (
                client.post(f"/tasks/{uuid.uuid4()}/play", json={"force": False}).status_code == 401
            )

    def test_play_ready_task_returns_202_and_persists_execution(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        task_id = _seed_task(sync_engine, project_id=seeded["proj_a"], lifecycle="ready")
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(f"/tasks/{task_id}/play", headers=h, json={"force": False})
            assert r.status_code == 202, r.text
            data = r.json()["data"]
            assert data["task_id"] == task_id
            assert data["lifecycle_stage"] == "in_progress"
            # e2e 通しで検出したパイプ断絶の回帰: play は常に queued
            # (spawning にすると Bridge pick が拾えず永遠に実行されない)
            assert data["dispatch_status"] == "queued"
            exec_id = data["execution_id"]
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select status, task_id from public.task_executions where id = cast(:i as uuid)"
                ),
                {"i": exec_id},
            ).first()
            assert row is not None and row.status == "running"
            tstage = c.execute(
                text(
                    "select lifecycle_stage, dispatch_status from public.tasks "
                    "where id = cast(:t as uuid)"
                ),
                {"t": task_id},
            ).first()
            assert tstage is not None
            assert str(tstage.lifecycle_stage) == "in_progress"
            audit_cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'task.play' and target_id = cast(:t as uuid)"
                ),
                {"t": task_id},
            ).scalar_one()
            assert audit_cnt == 1

    def test_play_404_for_nonexistent_task(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(f"/tasks/{uuid.uuid4()}/play", headers=h, json={"force": False})
            assert r.status_code == 404

    def test_play_409_when_not_in_playable_stage(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        task_id = _seed_task(sync_engine, project_id=seeded["proj_a"], lifecycle="done")
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(f"/tasks/{task_id}/play", headers=h, json={"force": False})
            assert r.status_code == 409

    def test_play_409_when_deps_not_done(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        # 依存先 task (in_progress, 未完)
        dep_id = _seed_task(
            sync_engine,
            project_id=seeded["proj_a"],
            lifecycle="in_progress",
            title="dep",
        )
        task_id = _seed_task(
            sync_engine,
            project_id=seeded["proj_a"],
            lifecycle="ready",
            title="dependent",
            deps=[dep_id],
        )
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(f"/tasks/{task_id}/play", headers=h, json={"force": False})
            assert r.status_code == 409

    def test_play_force_bypasses_deps(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        dep_id = _seed_task(
            sync_engine,
            project_id=seeded["proj_a"],
            lifecycle="ready",
            title="dep2",
        )
        task_id = _seed_task(
            sync_engine,
            project_id=seeded["proj_a"],
            lifecycle="ready",
            title="forceable",
            deps=[dep_id],
        )
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(f"/tasks/{task_id}/play", headers=h, json={"force": True})
            assert r.status_code == 202

    def test_play_blocked_task_is_allowed(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        task_id = _seed_task(sync_engine, project_id=seeded["proj_a"], lifecycle="blocked")
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(f"/tasks/{task_id}/play", headers=h, json={"force": False})
            assert r.status_code == 202

    def test_play_cross_workspace_404(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        task_id = _seed_task(sync_engine, project_id=seeded["proj_a"], lifecycle="ready")
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            r = client.post(f"/tasks/{task_id}/play", headers=hb, json={"force": False})
            assert r.status_code == 404


@pytest.mark.integration
class TestSpecChangesAndRelated:
    """GAP-025: 仕様変更検知 3 択 + 関連資料 + 検証担当。"""

    def _mk_task_with_mock(self, sync_engine: sqlalchemy.Engine, proj: str) -> tuple[str, str, str]:
        """task + mock v1 (紐付け) + mock v2 (新版) を seed。"""
        task_id, mock_v1, mock_v2 = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
        with sync_engine.begin() as c:
            for mid, ver in ((mock_v1, 1), (mock_v2, 2)):
                c.execute(
                    text(
                        "insert into public.mocks (id, project_id, screen_name, "
                        "html_storage_path, version) values (cast(:i as uuid), "
                        "cast(:p as uuid), 'S-A01', :path, :v)"
                    ),
                    {"i": mid, "p": proj, "path": f"mocks/s-a01-v{ver}.html", "v": ver},
                )
            c.execute(
                text(
                    "insert into public.tasks (id, project_id, category, title, type, "
                    "estimated_hours, mock_id, spec_html_path, files_changed) "
                    "values (cast(:i as uuid), cast(:p as uuid), 'misc', "
                    "'サインイン画面の実装', 'screen', 4, cast(:m as uuid), "
                    "'specs/t-014.html', array['a.tsx','b.tsx'])"
                ),
                {"i": task_id, "p": proj, "m": mock_v1},
            )
        return task_id, mock_v1, mock_v2

    def test_spec_change_detected_and_adopt(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, seeded: dict[str, str]
    ) -> None:
        task_id, _v1, mock_v2 = self._mk_task_with_mock(sync_engine, seeded["proj_a"])
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/tasks/{task_id}/spec-changes", headers=h)
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d is not None
            assert d["kind"] == "mock_updated"
            assert d["current_version"] == 1
            assert d["latest_version"] == 2
            assert d["latest_mock_id"] == mock_v2
            # adopt → mock_id 差替 + 解決記録で再表示されない
            r = client.post(
                f"/tasks/{task_id}/spec-changes/resolve",
                headers=h,
                json={"choice": "adopt", "latest_mock_id": mock_v2},
            )
            assert r.status_code == 200, r.text
            assert "取り込みました" in r.json()["data"]["note"]
            r = client.get(f"/tasks/{task_id}/spec-changes", headers=h)
            assert r.json()["data"] is None
        with sync_engine.begin() as c:
            row = c.execute(
                text("select mock_id from public.tasks where id = cast(:i as uuid)"),
                {"i": task_id},
            ).first()
            assert row is not None and str(row.mock_id) == mock_v2

    def test_spec_change_split_and_discard(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, seeded: dict[str, str]
    ) -> None:
        task_id, _v1, mock_v2 = self._mk_task_with_mock(sync_engine, seeded["proj_a"])
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/tasks/{task_id}/spec-changes/resolve",
                headers=h,
                json={"choice": "split", "latest_mock_id": mock_v2},
            )
            assert r.status_code == 200, r.text
            follow_up = r.json()["data"]["follow_up_task_id"]
            assert follow_up
            r = client.get(f"/tasks/{follow_up}", headers=h)
            assert r.json()["data"]["category"] == "仕様変更フォロー"
            assert "見積は未実施" in r.json()["data"]["description"]
        # discard (別タスクで)
        task2, _x, mock2_v2 = self._mk_task_with_mock(sync_engine, seeded["proj_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/tasks/{task2}/spec-changes/resolve",
                headers=h,
                json={"choice": "discard", "latest_mock_id": mock2_v2},
            )
            assert r.status_code == 200
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select lifecycle_stage, blocked_reason from public.tasks "
                    "where id = cast(:i as uuid)"
                ),
                {"i": task2},
            ).first()
            assert row is not None
            assert str(row.lifecycle_stage) == "blocked"
            assert "再分解待ち" in str(row.blocked_reason)

    def test_spec_change_cross_ws_404(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, seeded: dict[str, str]
    ) -> None:
        task_id, _v1, _v2 = self._mk_task_with_mock(sync_engine, seeded["proj_a"])
        with TestClient(app) as client:
            r = client.get(f"/tasks/{task_id}/spec-changes", headers=_h(seeded["u_b"]))
            assert r.status_code == 404

    def test_related_resources_real_links_only(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, seeded: dict[str, str]
    ) -> None:
        task_id, _v1, _v2 = self._mk_task_with_mock(sync_engine, seeded["proj_a"])
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/tasks/{task_id}/related", headers=h)
            assert r.status_code == 200, r.text
            items = r.json()["data"]
            kinds = [i["kind"] for i in items]
            assert "mock" in kinds
            assert "spec" in kinds
            assert "branch" in kinds  # files_changed 2 件
            branch = next(i for i in items if i["kind"] == "branch")
            assert "変更 2 ファイル" in branch["meta"]
            # AC / knowledge は未紐付けなので返さない (実リンクのみ)
            assert "acceptance_criteria" not in kinds
            assert "knowledge" not in kinds

    def test_verifier_assignment_and_cross_ws_422(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, seeded: dict[str, str]
    ) -> None:
        task_id, _v1, _v2 = self._mk_task_with_mock(sync_engine, seeded["proj_a"])
        h = _h(seeded["u_a"])
        with sync_engine.begin() as c:
            own = c.execute(
                text(
                    "select id from public.ai_employees where workspace_id = cast(:w as uuid) limit 1"
                ),
                {"w": seeded["ws_a"]},
            ).scalar_one()
            other = c.execute(
                text(
                    "select id from public.ai_employees where workspace_id = cast(:w as uuid) limit 1"
                ),
                {"w": seeded["ws_b"]},
            ).scalar_one()
        with TestClient(app) as client:
            r = client.patch(
                f"/tasks/{task_id}", headers=h, json={"verifier_employee_id": str(own)}
            )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["verifier_employee_id"] == str(own)
            # 他 WS の社員は 422
            r = client.patch(
                f"/tasks/{task_id}", headers=h, json={"verifier_employee_id": str(other)}
            )
            assert r.status_code == 422
            # "" で解除
            r = client.patch(f"/tasks/{task_id}", headers=h, json={"verifier_employee_id": ""})
            assert r.json()["data"]["verifier_employee_id"] is None


@pytest.mark.integration
class TestScreenMockLink:
    """GAP-140: タスク⇄画面モックの双方向ループ (分解時プレースホルダー)。"""

    @pytest.fixture(autouse=True)
    def _patch_content_store(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # mock_contents (RLS default deny) はテスト PG に向けた service 経路で書く
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from sqlalchemy.pool import NullPool as _NP

        from src.services.mocks import artifacts as artifacts_svc

        eng = create_async_engine(PG_ASYNC, poolclass=_NP)
        monkeypatch.setattr(
            artifacts_svc,
            "service_session_factory",
            lambda: async_sessionmaker(eng, class_=AsyncSession),
        )

    def _cleanup_screen(self, sync_engine: sqlalchemy.Engine, proj: str) -> None:
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "delete from public.mock_contents where id in ("
                    "  select substring(html_storage_path from 10)::uuid from public.mocks "
                    "  where project_id=cast(:p as uuid) and html_storage_path like 'mockdb://%')"
                ),
                {"p": proj},
            )

    def test_create_with_screen_name_makes_placeholder_and_links(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "screen",
                    "title": "ログイン画面の実装",
                    "type": "feature",
                    "estimated_hours": 4,
                    "screen_name": "ログイン画面",
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            task = r.json()["data"]
            assert task["mock_id"] is not None
            assert task["mock_screen_name"] == "ログイン画面"

            # プレースホルダー v1 が S-H01 に見える (mockdb 保存)
            mock = client.get(f"/mocks/{task['mock_id']}", headers=h).json()["data"]
            assert mock["version"] == 1
            assert mock["html_storage_path"].startswith("mockdb://")
            assert mock["meta_tags"]["source"] == "task_placeholder"

            # 同じ画面名の 2 個目のタスクは新規作成せず同じチェーンに紐づく
            r2 = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "screen",
                    "title": "ログイン画面のバリデーション",
                    "type": "feature",
                    "estimated_hours": 2,
                    "screen_name": "ログイン画面",
                },
                headers=h,
            )
            assert r2.json()["data"]["mock_id"] == task["mock_id"]
        self._cleanup_screen(sync_engine, seeded["proj_a"])

    def test_placeholder_then_new_version_triggers_spec_change(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """分解 → プレースホルダー → 作り込み (新版) → 仕様変更カード (GAP-025 連動)。"""
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            task = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "screen",
                    "title": "設定画面の実装",
                    "type": "feature",
                    "estimated_hours": 4,
                    "screen_name": "設定画面",
                },
                headers=h,
            ).json()["data"]

            # チャット成果物の取り込みと同じ経路で v2 (作り込み) が生まれる
            async def _ingest() -> None:
                from sqlalchemy.ext.asyncio import create_async_engine
                from sqlalchemy.pool import NullPool as _NP

                from src.services.mocks.artifacts import ingest_html_artifact

                eng = create_async_engine(PG_ASYNC, poolclass=_NP)
                try:
                    async with AsyncSession(eng) as s:
                        await ingest_html_artifact(
                            s,
                            project_id=seeded["proj_a"],
                            file_name="settings.html",
                            html="<html><title>設定画面</title><body>作り込み</body></html>",
                            source="chat_pc_tools",
                            actor_label="bridge",
                        )
                        await s.commit()
                finally:
                    await eng.dispose()

            asyncio.run(_ingest())

            sc = client.get(f"/tasks/{task['id']}/spec-changes", headers=h)
            assert sc.status_code == 200
            data = sc.json()["data"]
            assert data is not None and data["kind"] == "mock_updated"
            assert data["screen_name"] == "設定画面"
            assert data["latest_version"] == 2
        self._cleanup_screen(sync_engine, seeded["proj_a"])

    def test_update_links_screen_after_the_fact(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            task = client.post(
                "/tasks",
                json={
                    "project_id": seeded["proj_a"],
                    "category": "general",
                    "title": "後付けタスク",
                    "type": "feature",
                    "estimated_hours": 1,
                },
                headers=h,
            ).json()["data"]
            assert task["mock_id"] is None
            r = client.patch(
                f"/tasks/{task['id']}",
                json={"screen_name": "ダッシュボード"},
                headers=h,
            )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["mock_screen_name"] == "ダッシュボード"
        self._cleanup_screen(sync_engine, seeded["proj_a"])
