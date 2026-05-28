"""Integration tests for /approval-inbox (T-A-32) — 実 Postgres + RLS + JWT。実 DB 無なら skip。

5 種統合 (task_approval / phase_approval / knowledge_write / comment_response /
scope_change) の inbox を本人のみ閲覧・decide できることを検証する。
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
    """u_a に 3 件 (2 pending + 1 approved)、u_b に 1 件 (越境テスト用)。"""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ai_t, ai_k, ai_c, ai_b = (
        str(uuid.uuid4()),
        str(uuid.uuid4()),
        str(uuid.uuid4()),
        str(uuid.uuid4()),
    )
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta32-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        # u_a の inbox 3 件
        rows = [
            (ai_t, u_a, "task_approval", "task", "u_a task pending", "pending", None, None),
            (
                ai_k,
                u_a,
                "knowledge_write",
                "knowledge_node",
                "u_a knowledge pending",
                "pending",
                None,
                None,
            ),
            (
                ai_c,
                u_a,
                "comment_response",
                "comment",
                "u_a comment approved",
                "approved",
                "now()",
                "looks good",
            ),
        ]
        for rid, uid, typ, ttype, title, st, resolved_expr, note in rows:
            c.execute(
                text(
                    "insert into public.approval_inbox "
                    "(id, user_id, type, target_type, target_id, title, status, "
                    " resolved_at, resolution_note) "
                    f"values (cast(:i as uuid), cast(:u as uuid), "
                    f" cast(:t as approval_inbox_type_enum), :tt, gen_random_uuid(), :tl, :s, "
                    f" {resolved_expr if resolved_expr else 'null'}, :n)"
                ),
                {"i": rid, "u": uid, "t": typ, "tt": ttype, "tl": title, "s": st, "n": note},
            )
        # u_b の inbox 1 件 (越境テスト用)
        c.execute(
            text(
                "insert into public.approval_inbox "
                "(id, user_id, type, target_type, target_id, title, status) "
                "values (cast(:i as uuid), cast(:u as uuid), "
                " cast('task_approval' as approval_inbox_type_enum), 'task', "
                " gen_random_uuid(), 'u_b inbox', 'pending')"
            ),
            {"i": ai_b, "u": u_b},
        )
    yield {
        "u_a": u_a,
        "u_b": u_b,
        "ai_t": ai_t,
        "ai_k": ai_k,
        "ai_c": ai_c,
        "ai_b": ai_b,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestApprovals:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/approval-inbox").status_code == 401

    def test_list_only_own_inbox(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get("/approval-inbox", headers=h)
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert {seeded["ai_t"], seeded["ai_k"], seeded["ai_c"]} <= ids
            # 別 user の inbox は不可視
            assert seeded["ai_b"] not in ids

    def test_filter_status_and_type(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            pending = client.get("/approval-inbox?status=pending", headers=h).json()["data"]
            pending_ids = {x["id"] for x in pending}
            assert seeded["ai_t"] in pending_ids
            assert seeded["ai_k"] in pending_ids
            assert seeded["ai_c"] not in pending_ids  # approved

            kw = client.get("/approval-inbox?type=knowledge_write", headers=h).json()["data"]
            assert {x["id"] for x in kw} == {seeded["ai_k"]}

    def test_get_detail(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            g = client.get(f"/approval-inbox/{seeded['ai_t']}", headers=h)
            assert g.status_code == 200
            assert g.json()["data"]["type"] == "task_approval"
            assert g.json()["data"]["status"] == "pending"

    def test_decide_approve_records_audit(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/approval-inbox/{seeded['ai_t']}/decide",
                json={"decision": "approve", "note": "ok"},
                headers=h,
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["status"] == "approved"
            assert d["resolved_at"] is not None
            assert d["resolution_note"] == "ok"
        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='approval.decide' and target_id=cast(:t as uuid) "
                    "and actor_id=:a"
                ),
                {"t": seeded["ai_t"], "a": seeded["u_a"]},
            ).scalar_one()
        assert n == 1

    def test_decide_reject(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/approval-inbox/{seeded['ai_k']}/decide",
                json={"decision": "reject", "note": "need more info"},
                headers=h,
            )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["status"] == "rejected"

    def test_decide_already_resolved_409(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            # ai_c は最初から approved → decide で 409 (pending でない)
            r = client.post(
                f"/approval-inbox/{seeded['ai_c']}/decide",
                json={"decision": "approve"},
                headers=h,
            )
            assert r.status_code == 409

    def test_cross_user_get_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        # u_a が u_b の inbox にアクセス → 404 (RLS で 0 行)
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert client.get(f"/approval-inbox/{seeded['ai_b']}", headers=h).status_code == 404

    def test_cross_user_decide_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.post(
                    f"/approval-inbox/{seeded['ai_b']}/decide",
                    json={"decision": "approve"},
                    headers=h,
                ).status_code
                == 404
            )
