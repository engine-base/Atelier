"""Integration tests for /executions/{id}/logs(/stream) (T-A-31) — 実 Postgres + RLS + JWT。

実行ログメタデータ + SSE 配信。401 / 404 / cross-workspace / SSE event 構造 /
terminal status での即時 end / max_duration timeout を網羅。
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
    task_running, task_done, task_cross = (
        str(uuid.uuid4()),
        str(uuid.uuid4()),
        str(uuid.uuid4()),
    )
    exec_running, exec_done, exec_cross = (
        str(uuid.uuid4()),
        str(uuid.uuid4()),
        str(uuid.uuid4()),
    )
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta31-{uid[:8]}@t.invalid"
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
        for tid, pid, title in (
            (task_running, proj_a, "running"),
            (task_done, proj_a, "done"),
            (task_cross, proj_b, "cross"),
        ):
            c.execute(
                text(
                    "insert into public.tasks "
                    "(id, project_id, category, title, type, estimated_hours, priority, "
                    "lifecycle_stage, dispatch_status) "
                    "values (cast(:i as uuid), cast(:p as uuid), 'misc', :t, "
                    "'feature', 2, 'medium', 'in_progress', 'running')"
                ),
                {"i": tid, "p": pid, "t": title},
            )
        c.execute(
            text(
                "insert into public.task_executions "
                "(id, task_id, started_at, status, logs_storage_path) "
                "values (cast(:i as uuid), cast(:t as uuid), now(), 'running', "
                "'logs/running.txt')"
            ),
            {"i": exec_running, "t": task_running},
        )
        c.execute(
            text(
                "insert into public.task_executions "
                "(id, task_id, started_at, completed_at, status, score, "
                "logs_storage_path) "
                "values (cast(:i as uuid), cast(:t as uuid), "
                "now() - interval '2 minutes', now() - interval '1 minute', "
                "'succeeded', 0.9, 'logs/done.txt')"
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
        "proj_a": proj_a,
        "exec_running": exec_running,
        "exec_done": exec_done,
        "exec_cross": exec_cross,
        "task_running": task_running,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


def _parse_sse(body: bytes) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for raw in body.split(b"\n\n"):
        line = raw.strip()
        if not line.startswith(b"data:"):
            continue
        events.append(json.loads(line[5:].strip()))
    return events


@pytest.mark.integration
class TestExecLogs:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get(f"/executions/{uuid.uuid4()}/logs").status_code == 401
            assert client.get(f"/executions/{uuid.uuid4()}/logs/stream").status_code == 401

    def test_get_meta_404_for_nonexistent(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/executions/{uuid.uuid4()}/logs", headers=h)
            assert r.status_code == 404

    def test_get_meta_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/executions/{seeded['exec_cross']}/logs", headers=ha)
            assert r.status_code == 404

    def test_get_meta_returns_status_and_path(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/executions/{seeded['exec_running']}/logs", headers=h)
            assert r.status_code == 200
            d = r.json()["data"]
            assert d["status"] == "running"
            assert d["logs_storage_path"] == "logs/running.txt"

    def test_stream_terminal_status_ends_immediately(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(
                f"/executions/{seeded['exec_done']}/logs/stream"
                "?poll_interval_seconds=0.1&max_duration_seconds=2",
                headers=h,
            )
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            events = _parse_sse(r.content)
            types = [e["type"] for e in events]
            assert types[0] == "snapshot"
            assert "end" in types
            snap = events[0]
            assert snap["status"] == "succeeded"

    def test_stream_running_max_duration_ends(self, app: FastAPI, seeded: dict[str, str]) -> None:
        """running execution は max_duration_seconds 経過で end ("timeout") する。"""
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(
                f"/executions/{seeded['exec_running']}/logs/stream"
                "?poll_interval_seconds=0.2&max_duration_seconds=1",
                headers=h,
            )
            assert r.status_code == 200
            events = _parse_sse(r.content)
            types = [e["type"] for e in events]
            assert "snapshot" in types
            assert "end" in types
            end = next(e for e in events if e["type"] == "end")
            assert end["status"] == "running"
            assert end.get("error_summary") == "max_duration reached"

    def test_stream_status_change_detected(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        """polling 中に DB 側で status が変化すると status_change → end が送られる。"""
        h = _h(seeded["u_a"])

        async def _flip_after(delay: float) -> None:
            await asyncio.sleep(delay)
            with sync_engine.begin() as c:
                c.execute(
                    text(
                        "update public.task_executions set "
                        "status = 'succeeded', completed_at = now() "
                        "where id = cast(:i as uuid)"
                    ),
                    {"i": seeded["exec_running"]},
                )

        # 非同期 flip を別スレッドで動かす
        import threading

        def _flip_thread() -> None:
            time.sleep(0.4)
            with sync_engine.begin() as c:
                c.execute(
                    text(
                        "update public.task_executions set "
                        "status = 'succeeded', completed_at = now() "
                        "where id = cast(:i as uuid)"
                    ),
                    {"i": seeded["exec_running"]},
                )

        t = threading.Thread(target=_flip_thread)
        t.start()
        try:
            with TestClient(app) as client:
                r = client.get(
                    f"/executions/{seeded['exec_running']}/logs/stream"
                    "?poll_interval_seconds=0.2&max_duration_seconds=3",
                    headers=h,
                )
                events = _parse_sse(r.content)
                types = [e["type"] for e in events]
                assert "snapshot" in types
                assert "status_change" in types or any(
                    e.get("status") == "succeeded" for e in events
                )
                end = next(e for e in events if e["type"] == "end")
                assert end["status"] == "succeeded"
        finally:
            t.join()

    def test_stream_nonexistent_emits_error_event(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(
                f"/executions/{uuid.uuid4()}/logs/stream"
                "?poll_interval_seconds=0.1&max_duration_seconds=1",
                headers=h,
            )
            # SSE response 自体は 200 だが error event を 1 件送って終了する
            assert r.status_code == 200
            events = _parse_sse(r.content)
            assert len(events) == 1
            assert events[0]["type"] == "error"

    def test_stream_validates_poll_interval(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(
                f"/executions/{seeded['exec_done']}/logs/stream?poll_interval_seconds=0.01",
                headers=h,
            )
            assert r.status_code == 422

    def test_stream_validates_max_duration(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(
                f"/executions/{seeded['exec_done']}/logs/stream?max_duration_seconds=99999",
                headers=h,
            )
            assert r.status_code == 422
