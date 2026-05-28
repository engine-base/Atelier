"""Integration tests for /cron-schedules (T-A-40) — 実 Postgres + RLS + JWT。実 DB 無なら skip。

owner / member / 越境の RLS 試験。delete は owner のみ (member は 403)、
越境は 404、状態変更は audit_logs に記録。
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
    """u_a=ws_a owner、u_m=ws_a member、u_b=ws_b owner (越境)。proj_a を ws_a に。"""
    u_a, u_m, u_b = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_m, u_b):
            em = f"ta40-{uid[:8]}@t.invalid"
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
                "insert into public.workspace_memberships (workspace_id,user_id,role) "
                "values (cast(:w as uuid),cast(:u as uuid),'member')"
            ),
            {"w": ws_a, "u": u_m},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
    yield {"u_a": u_a, "u_m": u_m, "u_b": u_b, "ws_a": ws_a, "proj_a": proj_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(
            text("delete from public.users where id in (:a,:m,:b)"),
            {"a": u_a, "m": u_m, "b": u_b},
        )
        c.execute(
            text("delete from auth.users where id in (:a,:m,:b)"),
            {"a": u_a, "m": u_m, "b": u_b},
        )


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestCronSchedules:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/cron-schedules").status_code == 401

    def test_create_and_audit(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/cron-schedules",
                json={
                    "project_id": seeded["proj_a"],
                    "name": "daily-digest",
                    "cron_expression": "0 9 * * *",
                    "target_action": "daily_digest",
                    "target_payload": {"timezone": "Asia/Tokyo"},
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            body = r.json()["data"]
            assert body["target_action"] == "daily_digest"
            assert body["enabled"] is True
            assert body["target_payload"] == {"timezone": "Asia/Tokyo"}
            sid = body["id"]
        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='cron_schedule.create' and target_id=cast(:t as uuid)"
                ),
                {"t": sid},
            ).scalar_one()
        assert n == 1

    def test_list_filter_and_detail(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            s1 = client.post(
                "/cron-schedules",
                json={
                    "project_id": seeded["proj_a"],
                    "name": "s1",
                    "cron_expression": "0 0 * * *",
                    "target_action": "task_replay",
                },
                headers=h,
            ).json()["data"]["id"]
            s2 = client.post(
                "/cron-schedules",
                json={
                    "project_id": seeded["proj_a"],
                    "name": "s2",
                    "cron_expression": "0 1 * * *",
                    "target_action": "report_summary",
                    "enabled": False,
                },
                headers=h,
            ).json()["data"]["id"]
            # 一覧 (project filter)
            lst = client.get(f"/cron-schedules?project_id={seeded['proj_a']}", headers=h).json()[
                "data"
            ]
            ids = {x["id"] for x in lst}
            assert {s1, s2} <= ids
            # enabled filter
            en = client.get(
                f"/cron-schedules?project_id={seeded['proj_a']}&enabled=true",
                headers=h,
            ).json()["data"]
            assert {x["id"] for x in en} == {s1}
            # 詳細
            d = client.get(f"/cron-schedules/{s2}", headers=h)
            assert d.status_code == 200
            assert d.json()["data"]["enabled"] is False

    def test_update_by_member(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hm = _h(seeded["u_a"]), _h(seeded["u_m"])
        with TestClient(app) as client:
            sid = client.post(
                "/cron-schedules",
                json={
                    "project_id": seeded["proj_a"],
                    "name": "weekly",
                    "cron_expression": "0 9 * * 1",
                    "target_action": "weekly_burndown",
                },
                headers=ha,
            ).json()["data"]["id"]
            # member が update (RLS update_member で許可)
            r = client.patch(
                f"/cron-schedules/{sid}",
                json={"enabled": False, "cron_expression": "0 10 * * 1"},
                headers=hm,
            )
            assert r.status_code == 200
            assert r.json()["data"]["enabled"] is False
            assert r.json()["data"]["cron_expression"] == "0 10 * * 1"

    def test_delete_owner_only_member_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hm = _h(seeded["u_a"]), _h(seeded["u_m"])
        with TestClient(app) as client:
            sid = client.post(
                "/cron-schedules",
                json={
                    "project_id": seeded["proj_a"],
                    "name": "delete-test",
                    "cron_expression": "0 0 * * *",
                    "target_action": "knowledge_organize",
                },
                headers=ha,
            ).json()["data"]["id"]
            # member は閲覧 OK
            assert client.get(f"/cron-schedules/{sid}", headers=hm).status_code == 200
            # が delete はできない (owner 限定)
            assert client.delete(f"/cron-schedules/{sid}", headers=hm).status_code == 403
            # owner なら 204
            assert client.delete(f"/cron-schedules/{sid}", headers=ha).status_code == 204
            assert client.get(f"/cron-schedules/{sid}", headers=ha).status_code == 404

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            sid = client.post(
                "/cron-schedules",
                json={
                    "project_id": seeded["proj_a"],
                    "name": "cross-test",
                    "cron_expression": "0 0 * * *",
                    "target_action": "industry_extract",
                },
                headers=ha,
            ).json()["data"]["id"]
            # 別 WS owner からは不可視 → 404
            assert client.get(f"/cron-schedules/{sid}", headers=hb).status_code == 404
            assert client.delete(f"/cron-schedules/{sid}", headers=hb).status_code == 404
            client.delete(f"/cron-schedules/{sid}", headers=ha)

    def test_invalid_target_action_422(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/cron-schedules",
                json={
                    "project_id": seeded["proj_a"],
                    "name": "x",
                    "cron_expression": "0 0 * * *",
                    "target_action": "evil_action",
                },
                headers=h,
            )
            assert r.status_code == 422
