"""Integration tests for T-A-49 — スキル管理 API (F-007)。実 Postgres + service_role write。

検証:
- POST /admin/skills (admin) で skills 行が作成され 201 + semver/unique を満たす。
- 非 admin は 403 (write 不可)。
- PATCH /admin/skills/{id} で content_md / is_active を更新できる。
- POST /admin/skills/{id}/attach で AI 社員の attached_skills に追加・解除される。
- DELETE /admin/skills/{id} で行が消え 204、不在は 404。
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
from typing import Any

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)
# service 層の _service_session_factory が ATELIER_DB_URL を直接読む。
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
    # service 層の lru_cache をクリア (ATELIER_DB_URL を確実に反映)。
    from src.services.skills import _service_session_factory

    _service_session_factory.cache_clear()
    from src.routes import api_router

    application = FastAPI()
    application.include_router(api_router)
    yield application
    _service_session_factory.cache_clear()


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    admin_u = str(uuid.uuid4())
    member_u = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    emp = str(uuid.uuid4())
    created: list[str] = []
    with sync_engine.begin() as c:
        for uid in (admin_u, member_u):
            em = f"ta49-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws, "o": admin_u, "n": f"ws-{ws[:6]}"},
        )
        c.execute(
            text(
                "insert into public.ai_employees (id,workspace_id,name,display_name,role,department,"
                "attached_skills,is_default) values (cast(:i as uuid),cast(:w as uuid),'tony','トニー',"
                "'lead','sales',array[]::uuid[],true)"
            ),
            {"i": emp, "w": ws},
        )
    yield {"admin": admin_u, "member": member_u, "ws": ws, "emp": emp}
    with sync_engine.begin() as c:
        if created:
            c.execute(
                text("delete from public.skills where id = any(cast(:ids as uuid[]))"),
                {"ids": created},
            )
        c.execute(text("delete from public.skills where name like 'ta49-%'"))
        c.execute(text("delete from public.ai_employees where id = cast(:i as uuid)"), {"i": emp})
        c.execute(text("delete from public.workspaces where id = cast(:i as uuid)"), {"i": ws})
        for uid in (admin_u, member_u):
            c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": uid})
            c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": uid})


def _h(uid: str, *, admin: bool = False) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid, admin=admin)}"}


def _create_body() -> dict[str, Any]:
    return {
        "name": f"ta49-{uuid.uuid4().hex[:8]}",
        "version": "1.0.0",
        "content_md": "# 提案スキル\n\n商談メモから提案書を作る。",
        "description": "営業提案",
        "allowed_employee_roles": ["lead"],
    }


def test_create_skill_admin(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        r = cl.post("/admin/skills", json=_create_body(), headers=_h(seeded["admin"], admin=True))
        assert r.status_code == 201, r.text
        data = r.json()["data"]
        assert data["version"] == "1.0.0"
        assert data["is_active"] is True
        assert data["allowed_employee_roles"] == ["lead"]


def test_create_skill_non_admin_forbidden(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        r = cl.post("/admin/skills", json=_create_body(), headers=_h(seeded["member"]))
        assert r.status_code == 403, r.text


def test_create_skill_rejects_non_semver(app: FastAPI, seeded: dict[str, str]) -> None:
    body = _create_body()
    body["version"] = "v1"
    with TestClient(app) as cl:
        r = cl.post("/admin/skills", json=body, headers=_h(seeded["admin"], admin=True))
        assert r.status_code == 422, r.text


def test_update_skill(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post("/admin/skills", json=_create_body(), headers=_h(seeded["admin"], admin=True))
        sid = cr.json()["data"]["id"]
        up = cl.patch(
            f"/admin/skills/{sid}",
            json={"content_md": "# 改訂", "is_active": False},
            headers=_h(seeded["admin"], admin=True),
        )
        assert up.status_code == 200, up.text
        assert up.json()["data"]["content_md"] == "# 改訂"
        assert up.json()["data"]["is_active"] is False


def test_update_missing_404(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        r = cl.patch(
            f"/admin/skills/{uuid.uuid4()}",
            json={"description": "x"},
            headers=_h(seeded["admin"], admin=True),
        )
        assert r.status_code == 404, r.text


def test_attach_and_detach_skill(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    with TestClient(app) as cl:
        cr = cl.post("/admin/skills", json=_create_body(), headers=_h(seeded["admin"], admin=True))
        sid = cr.json()["data"]["id"]
        at = cl.post(
            f"/admin/skills/{sid}/attach",
            json={"ai_employee_id": seeded["emp"], "attached": True},
            headers=_h(seeded["admin"], admin=True),
        )
        assert at.status_code == 200, at.text
    with sync_engine.connect() as c:
        row = c.execute(
            text("select attached_skills from public.ai_employees where id = cast(:i as uuid)"),
            {"i": seeded["emp"]},
        ).first()
        assert row is not None and uuid.UUID(sid) in list(row.attached_skills)
    with TestClient(app) as cl:
        de = cl.post(
            f"/admin/skills/{sid}/attach",
            json={"ai_employee_id": seeded["emp"], "attached": False},
            headers=_h(seeded["admin"], admin=True),
        )
        assert de.status_code == 200, de.text
    with sync_engine.connect() as c:
        row = c.execute(
            text("select attached_skills from public.ai_employees where id = cast(:i as uuid)"),
            {"i": seeded["emp"]},
        ).first()
        assert row is not None and uuid.UUID(sid) not in list(row.attached_skills)


def test_attach_missing_employee_404(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post("/admin/skills", json=_create_body(), headers=_h(seeded["admin"], admin=True))
        sid = cr.json()["data"]["id"]
        r = cl.post(
            f"/admin/skills/{sid}/attach",
            json={"ai_employee_id": str(uuid.uuid4()), "attached": True},
            headers=_h(seeded["admin"], admin=True),
        )
        assert r.status_code == 404, r.text


def test_delete_skill(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post("/admin/skills", json=_create_body(), headers=_h(seeded["admin"], admin=True))
        sid = cr.json()["data"]["id"]
        de = cl.delete(f"/admin/skills/{sid}", headers=_h(seeded["admin"], admin=True))
        assert de.status_code == 204, de.text
        miss = cl.delete(f"/admin/skills/{sid}", headers=_h(seeded["admin"], admin=True))
        assert miss.status_code == 404, miss.text
