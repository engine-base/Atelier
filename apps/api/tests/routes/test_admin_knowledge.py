"""Integration tests for T-A-50 — 運営ナレッジ管理 API (F-023)。実 Postgres + service_role。

検証:
- POST /admin/knowledge (admin) で account_type=platform + sentinel account_id の行が作成され 201。
- 非 admin は 403 / 未認証は 401。
- PATCH で visible_in_tree をトグルし、別 GET (一覧) で反映される（永続化）。
- GET 一覧は運営ナレッジを全件返す。DELETE で 204、再 DELETE で 404。
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
os.environ.setdefault("ATELIER_DB_URL", PG_ASYNC)
os.environ.pop("VOYAGE_API_KEY", None)

import sqlalchemy  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

_SENTINEL = "00000000-0000-0000-0000-000000000000"


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
    from src.routes.admin_knowledge import (
        _service_session_factory,  # pyright: ignore[reportPrivateUsage]
    )

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
    with sync_engine.begin() as c:
        for uid in (admin_u, member_u):
            em = f"ta50-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
    yield {"admin": admin_u, "member": member_u}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.knowledge_nodes where category = 'ta50-test'"))
        for uid in (admin_u, member_u):
            c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": uid})
            c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": uid})


def _h(uid: str, *, admin: bool = False) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid, admin=admin)}"}


def _body(title: str = "運営FAQ") -> dict[str, Any]:
    return {
        "category": "ta50-test",
        "title": title,
        "content_md": "# 運営デフォルト\n\n横断参照される。",
    }


def test_create_platform_knowledge_admin(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    with TestClient(app) as cl:
        r = cl.post("/admin/knowledge", json=_body(), headers=_h(seeded["admin"], admin=True))
        assert r.status_code == 201, r.text
        data = r.json()["data"]
        assert data["account_type"] == "platform"
        assert data["account_id"] == _SENTINEL
        assert data["visible_in_tree"] is False
    with sync_engine.connect() as c:
        row = c.execute(
            text(
                "select account_type, account_id from public.knowledge_nodes "
                "where id = cast(:i as uuid)"
            ),
            {"i": data["id"]},
        ).first()
        assert row is not None and str(row.account_type) == "platform"
        assert str(row.account_id) == _SENTINEL


def test_create_non_admin_forbidden(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        r = cl.post("/admin/knowledge", json=_body(), headers=_h(seeded["member"]))
        assert r.status_code == 403, r.text


def test_unauthenticated_401(app: FastAPI) -> None:
    with TestClient(app) as cl:
        assert cl.post("/admin/knowledge", json=_body()).status_code == 401
        assert cl.get("/admin/knowledge").status_code == 401


def test_toggle_visible_in_tree_persists(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post("/admin/knowledge", json=_body(), headers=_h(seeded["admin"], admin=True))
        kid = cr.json()["data"]["id"]
        up = cl.patch(
            f"/admin/knowledge/{kid}",
            json={"visible_in_tree": True},
            headers=_h(seeded["admin"], admin=True),
        )
        assert up.status_code == 200, up.text
        assert up.json()["data"]["visible_in_tree"] is True
        # 別 GET（一覧）で反映を確認。
        ls = cl.get("/admin/knowledge", headers=_h(seeded["admin"], admin=True))
        assert ls.status_code == 200, ls.text
        match = [x for x in ls.json()["data"] if x["id"] == kid]
        assert match and match[0]["visible_in_tree"] is True


def test_list_and_delete(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post(
            "/admin/knowledge", json=_body("消す対象"), headers=_h(seeded["admin"], admin=True)
        )
        kid = cr.json()["data"]["id"]
        ls = cl.get("/admin/knowledge", headers=_h(seeded["admin"], admin=True))
        assert kid in {x["id"] for x in ls.json()["data"]}
        de = cl.delete(f"/admin/knowledge/{kid}", headers=_h(seeded["admin"], admin=True))
        assert de.status_code == 204, de.text
        miss = cl.delete(f"/admin/knowledge/{kid}", headers=_h(seeded["admin"], admin=True))
        assert miss.status_code == 404, miss.text


def test_patch_non_admin_forbidden(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        cr = cl.post("/admin/knowledge", json=_body(), headers=_h(seeded["admin"], admin=True))
        kid = cr.json()["data"]["id"]
        r = cl.patch(
            f"/admin/knowledge/{kid}",
            json={"title": "x"},
            headers=_h(seeded["member"]),
        )
        assert r.status_code == 403, r.text
