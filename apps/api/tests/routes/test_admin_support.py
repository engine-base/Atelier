"""GAP-031⑥ サポート連絡 (POST /admin/support-contact) の integration tests。

dev/CI はメール未設定のため ResendSender は dry-run — 応答の dry_run=true と
audit support.contact 記録、履歴逆引き (GET /admin/support-contacts) を検証する。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from collections.abc import Iterator
from typing import Any, cast

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)
os.environ.setdefault("ATELIER_DB_URL", PG_ASYNC)

import sqlalchemy  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_jwt(user_id: str, *, admin: bool = False) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload_obj: dict[str, Any] = {
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
    from src.services.support import (
        _session_factory_for_loop,  # pyright: ignore[reportPrivateUsage]  # lru_cache 実体を clear
    )

    _session_factory_for_loop.cache_clear()
    from src.routes import api_router

    application = FastAPI()
    application.include_router(api_router)
    yield application
    _session_factory_for_loop.cache_clear()


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    admin_u, member_u = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (admin_u, member_u):
            em = f"gap031f-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email,display_name) values (:i,:e,:n)"),
                {"i": uid, "e": em, "n": f"user-{uid[:6]}"},
            )
    yield {"admin": admin_u, "member": member_u}
    with sync_engine.begin() as c:
        for uid in (admin_u, member_u):
            c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": uid})
            c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": uid})


def _h(uid: str, *, admin: bool = False) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid, admin=admin)}"}


@pytest.mark.integration
class TestSupportContact:
    def test_send_records_audit_and_lists(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        subject = f"課金タイミングについて-{uuid.uuid4().hex[:6]}"
        with TestClient(app) as cl:
            r = cl.post(
                "/admin/support-contact",
                json={"user_id": seeded["member"], "subject": subject, "message": "ご案内です。"},
                headers=_h(seeded["admin"], admin=True),
            )
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            assert data["dry_run"] is True  # メール未設定環境は dry-run を明示
            assert data["to_email"].startswith("gap031f-")
            # audit support.contact
            with sync_engine.begin() as c:
                row = c.execute(
                    text(
                        "select after from public.audit_logs "
                        "where action = 'support.contact' and target_id = cast(:t as uuid) "
                        "order by created_at desc limit 1"
                    ),
                    {"t": seeded["member"]},
                ).one()
                after_raw: Any = row.after
                after = cast(
                    "dict[str, Any]",
                    after_raw if isinstance(after_raw, dict) else json.loads(after_raw),
                )
                assert after["subject"] == subject
                assert after["dry_run"] is True
            # 履歴逆引き
            r2 = cl.get("/admin/support-contacts", headers=_h(seeded["admin"], admin=True))
            assert r2.status_code == 200
            subjects = [x["subject"] for x in r2.json()["data"]]
            assert subject in subjects

    def test_non_admin_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as cl:
            r = cl.post(
                "/admin/support-contact",
                json={"user_id": seeded["admin"], "subject": "x", "message": "y"},
                headers=_h(seeded["member"]),
            )
            assert r.status_code == 403
            assert (
                cl.get("/admin/support-contacts", headers=_h(seeded["member"])).status_code == 403
            )

    def test_missing_user_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as cl:
            r = cl.post(
                "/admin/support-contact",
                json={"user_id": str(uuid.uuid4()), "subject": "x", "message": "y"},
                headers=_h(seeded["admin"], admin=True),
            )
            assert r.status_code == 404
