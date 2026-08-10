"""Integration tests for GAP-019 S-T01 admin ops (mission / trends / channels /
health / beta FB / costs / platform stats) — 実 Postgres。実 DB 無なら skip。

platform データは is_admin ゲート + service session (RLS bypass)。
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
os.environ.setdefault("ATELIER_DB_URL", PG_ASYNC)

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402
from src.services.admin.ops import service_session_factory  # noqa: E402


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_jwt(user_id: str, *, admin: bool = False) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload_obj: dict[str, object] = {
        "sub": user_id,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": int(time.time()) + 3600,
    }
    if admin:
        payload_obj["app_metadata"] = {"role": "admin"}
    payload = _b64url(json.dumps(payload_obj).encode())
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
    service_session_factory.cache_clear()
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
    service_session_factory.cache_clear()
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_admin, u_member = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_admin, u_member):
            em = f"gap019-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
    yield {"u_admin": u_admin, "u_member": u_member}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.beta_feedback where user_id in (:a,:b)"),
            {"a": u_admin, "b": u_member},
        )
        c.execute(
            text("delete from public.admin_goals where goal_key = 'acquisition'"),
        )
        c.execute(text("delete from public.acquisition_records where note like 'gap019-%'"))
        c.execute(text("delete from public.admin_costs where name like 'gap019-%'"))
        c.execute(
            text("delete from public.users where id in (:a,:b)"), {"a": u_admin, "b": u_member}
        )
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_admin, "b": u_member})


def _h(uid: str, *, admin: bool = False) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid, admin=admin)}"}


@pytest.mark.integration
class TestAdminOps:
    def test_non_admin_forbidden_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_member"])
        with TestClient(app) as client:
            for path in (
                "/admin/mission",
                "/admin/trends",
                "/admin/acquisitions",
                "/admin/health",
                "/admin/platform-stats",
                "/admin/beta-feedback",
                "/admin/costs",
            ):
                assert client.get(path, headers=h).status_code == 403, path

    def test_mission_goal_lifecycle(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_admin"], admin=True)
        with TestClient(app) as client:
            m0 = client.get("/admin/mission", headers=h)
            assert m0.status_code == 200
            assert m0.json()["data"]["goal"] is None
            assert m0.json()["data"]["current_count"] >= 0

            r = client.put(
                "/admin/goal",
                headers=h,
                json={
                    "title": "100 社獲得",
                    "target_count": 100,
                    "deadline": "2026-12-31",
                    "note": "想定 ARR ¥36M",
                },
            )
            assert r.status_code == 200, r.text
            m1 = client.get("/admin/mission", headers=h).json()["data"]
            assert m1["goal"]["target_count"] == 100
            assert m1["remaining"] == max(0, 100 - m1["current_count"])
            assert m1["months_left"] is not None
            assert m1["needed_per_month"] is not None

    def test_trends_real_cumulative(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_admin"], admin=True)
        with TestClient(app) as client:
            r = client.get("/admin/trends?days=60", headers=h)
            assert r.status_code == 200
            data = r.json()["data"]
            points = data["points"]
            assert len(points) >= 8
            # 累計は単調非減少
            ws = [p["workspaces"] for p in points]
            assert ws == sorted(ws)
            # 課金未導入 → MRR は実額 0 (偽装しない)
            assert data["billing_enabled"] is False
            assert data["mrr_yen"] == 0

    def test_acquisitions_record_and_aggregate(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_admin"], admin=True)
        with TestClient(app) as client:
            for ch in ("referral", "referral", "sns"):
                assert (
                    client.post(
                        "/admin/acquisitions",
                        headers=h,
                        json={"channel": ch, "note": "gap019-test"},
                    ).status_code
                    == 201
                )
            agg = client.get("/admin/acquisitions?days=7", headers=h).json()["data"]
            by = {c["channel"]: c["count"] for c in agg["channels"]}
            assert by.get("referral", 0) >= 2
            assert by.get("sns", 0) >= 1
            assert agg["total"] >= 3
            rec_id = agg["recent"][0]["id"]
            assert client.delete(f"/admin/acquisitions/{rec_id}", headers=h).status_code == 204
            assert client.delete("/admin/acquisitions/not-a-uuid", headers=h).status_code == 404

    def test_health_real_measurements(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_admin"], admin=True)
        with TestClient(app) as client:
            r = client.get("/admin/health", headers=h)
            assert r.status_code == 200
            rows = {x["name"]: x for x in r.json()["data"]}
            assert "実測" in rows["API ↔ DB 接続"]["detail"]
            assert "接続数" in rows["PostgreSQL"]["detail"]
            assert "Bridge" in rows["ディスパッチャ / Bridge"]["detail"]
            # 外部 API は設定有無の事実のみ
            assert rows["Resend (メール)"]["meta"] in ("設定済", "未設定")

    def test_beta_feedback_lifecycle(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        member_h = _h(seeded["u_member"])
        admin_h = _h(seeded["u_admin"], admin=True)
        with TestClient(app) as client:
            # 投稿は一般ユーザーでも可 (収集)
            r = client.post(
                "/beta-feedback",
                headers=member_h,
                json={"category": "bug", "content": "再生を連打するとエラー"},
            )
            assert r.status_code == 201, r.text
            fb = r.json()["data"]
            assert fb["status"] == "open"
            assert fb["email"].startswith("gap019-")

            lst = client.get("/admin/beta-feedback?status=open", headers=admin_h).json()["data"]
            assert any(x["id"] == fb["id"] for x in lst)

            res = client.post(f"/admin/beta-feedback/{fb['id']}/resolve", headers=admin_h)
            assert res.status_code == 200
            assert res.json()["data"]["status"] == "resolved"
            # 二重 resolve は 404 (open のみ対象)
            assert (
                client.post(f"/admin/beta-feedback/{fb['id']}/resolve", headers=admin_h).status_code
                == 404
            )
            stats = client.get("/admin/platform-stats", headers=admin_h).json()["data"]
            assert stats["beta_feedback_total"] >= 1
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs where action in "
                        "('beta.feedback.create','beta.feedback.resolve') and target_id=:t"
                    ),
                    {"t": fb["id"]},
                ).scalar_one()
            assert n == 2

    def test_costs_record_and_total(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_admin"], admin=True)
        with TestClient(app) as client:
            for name, amount in (("gap019-Fly.io", 328), ("gap019-Claude API", 578)):
                assert (
                    client.post(
                        "/admin/costs",
                        headers=h,
                        json={"month": "2026-08-15", "name": name, "amount_yen": amount},
                    ).status_code
                    == 201
                )
            data = client.get("/admin/costs?month=2026-08-01", headers=h).json()["data"]
            ours = [i for i in data["items"] if i["name"].startswith("gap019-")]
            assert len(ours) == 2
            assert sum(i["amount_yen"] for i in ours) == 906
            # 月初への正規化
            assert data["month"] == "2026-08-01"
            cid = ours[0]["id"]
            assert client.delete(f"/admin/costs/{cid}", headers=h).status_code == 204
