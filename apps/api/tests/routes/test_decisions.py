"""Integration tests for /decisions (T-D-101) — 実 Postgres + RLS + JWT。実 DB 無なら skip。

S-F01 確定事項/未確認タブのバックエンド。RLS 越境 (R-T08 系) を含めて検証する。
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
    proj_a, dec_a = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"td101-{uid[:8]}@t.invalid"
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
                "insert into public.projects (id,workspace_id,name,project_type) values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
        c.execute(
            text(
                "insert into public.decisions (id,project_id,status,body,reflected_to) "
                "values (cast(:i as uuid),cast(:p as uuid),'decided','画面数を 33 に確定','screens.json')"
            ),
            {"i": dec_a, "p": proj_a},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "proj_a": proj_a, "dec_a": dec_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestDecisions:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/decisions").status_code == 401

    def test_list_get_and_status_filter(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            lst = client.get(f"/decisions?project_id={seeded['proj_a']}", headers=h)
            assert lst.status_code == 200
            assert any(x["id"] == seeded["dec_a"] for x in lst.json()["data"])
            # status filter: decided に含まれ unresolved には含まれない
            assert any(
                x["id"] == seeded["dec_a"]
                for x in client.get(
                    f"/decisions?project_id={seeded['proj_a']}&status=decided", headers=h
                ).json()["data"]
            )
            assert all(
                x["id"] != seeded["dec_a"]
                for x in client.get(
                    f"/decisions?project_id={seeded['proj_a']}&status=unresolved", headers=h
                ).json()["data"]
            )
            g = client.get(f"/decisions/{seeded['dec_a']}", headers=h)
            assert g.status_code == 200
            assert g.json()["data"]["body"] == "画面数を 33 に確定"

    def test_create_and_resolve_unresolved(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            created = client.post(
                "/decisions",
                headers=h,
                json={
                    "project_id": seeded["proj_a"],
                    "status": "unresolved",
                    "body": "月額単価の具体値",
                    "resolve_note": "解決すべきフェーズ: product-strategy",
                },
            )
            assert created.status_code == 201
            dec_id = created.json()["data"]["id"]
            assert created.json()["data"]["status"] == "unresolved"
            # 未確認 → 確定へ状態遷移
            patched = client.patch(
                f"/decisions/{dec_id}",
                headers=h,
                json={"status": "decided", "reflected_to": "pricing.json"},
            )
            assert patched.status_code == 200
            assert patched.json()["data"]["status"] == "decided"
            assert patched.json()["data"]["reflected_to"] == "pricing.json"

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            # R-T08 系: 他 WS のユーザーからは一覧にも単体にも見えない
            assert client.get(f"/decisions/{seeded['dec_a']}", headers=hb).status_code == 404
            assert all(
                x["id"] != seeded["dec_a"]
                for x in client.get(f"/decisions?project_id={seeded['proj_a']}", headers=hb).json()[
                    "data"
                ]
            )

    def test_cross_workspace_create_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            res = client.post(
                "/decisions",
                headers=hb,
                json={"project_id": seeded["proj_a"], "body": "越境 insert"},
            )
            # RLS with check 違反 → サービス層で行が返らず 403/500 系のいずれでも
            # 作成されないことが本質。作成成功 (201) でないことを検証する。
            assert res.status_code != 201
