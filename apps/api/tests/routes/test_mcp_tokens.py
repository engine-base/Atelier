"""Integration tests for /mcp-tokens (T-A-08) — 実 Postgres + RLS + JWT。実 DB 無なら skip。

owner / member / 越境の 3 ロールで token CRUD + revoke を検証。
plaintext token は create 応答で 1 度だけ返ること、DB には sha256-hex が保存
されること、revoke は owner 限定 (member は 403) を確認する。
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
    """u_a=ws_a owner、u_m=ws_a member、u_b=ws_b owner (越境)。"""
    u_a, u_m, u_b = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_m, u_b):
            em = f"ta08-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        # u_m を ws_a の member として追加
        c.execute(
            text(
                "insert into public.workspace_memberships (workspace_id,user_id,role) "
                "values (cast(:w as uuid),cast(:u as uuid),'member')"
            ),
            {"w": ws_a, "u": u_m},
        )
    yield {"u_a": u_a, "u_m": u_m, "u_b": u_b, "ws_a": ws_a, "ws_b": ws_b}
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
class TestMcpTokens:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/mcp-tokens").status_code == 401

    def test_create_returns_plaintext_and_stores_hash(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/mcp-tokens",
                json={
                    "workspace_id": seeded["ws_a"],
                    "name": "my token",
                    "scopes": ["read:tasks", "write:tasks"],
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            body = r.json()["data"]
            assert "token" in body and len(body["token"]) >= 32
            tid = body["id"]
            assert body["scopes"] == ["read:tasks", "write:tasks"]
        # DB には sha256-hex (64 char) が保存され plaintext は含まれない
        with sync_engine.connect() as c:
            row = c.execute(
                text("select token_hash from public.mcp_tokens where id = cast(:i as uuid)"),
                {"i": tid},
            ).first()
        assert row is not None
        h_stored = row[0]
        assert len(h_stored) == 64
        assert all(ch in "0123456789abcdef" for ch in h_stored)
        # audit_logs に記録
        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='mcp_token.create' and target_id=cast(:t as uuid)"
                ),
                {"t": tid},
            ).scalar_one()
        assert n == 1

    def test_list_workspace_and_include_revoked(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            # 2 件作成 → 1 件を revoke
            t1 = client.post(
                "/mcp-tokens",
                json={"workspace_id": seeded["ws_a"], "name": "t1"},
                headers=h,
            ).json()["data"]["id"]
            t2 = client.post(
                "/mcp-tokens",
                json={"workspace_id": seeded["ws_a"], "name": "t2"},
                headers=h,
            ).json()["data"]["id"]
            client.delete(f"/mcp-tokens/{t1}", headers=h)

            # デフォルトは revoked 除外
            lst = client.get(f"/mcp-tokens?workspace_id={seeded['ws_a']}", headers=h).json()["data"]
            ids = {x["id"] for x in lst}
            assert t2 in ids
            assert t1 not in ids
            # include_revoked=true で全件
            lst2 = client.get(
                f"/mcp-tokens?workspace_id={seeded['ws_a']}&include_revoked=true",
                headers=h,
            ).json()["data"]
            ids2 = {x["id"] for x in lst2}
            assert t1 in ids2 and t2 in ids2

    def test_get_detail_and_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            tid = client.post(
                "/mcp-tokens",
                json={"workspace_id": seeded["ws_a"], "name": "x"},
                headers=ha,
            ).json()["data"]["id"]
            assert client.get(f"/mcp-tokens/{tid}", headers=ha).status_code == 200
            # 別 WS の user → 不可視 → 404
            assert client.get(f"/mcp-tokens/{tid}", headers=hb).status_code == 404

    def test_revoke_owner_204_and_audit(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = client.post(
                "/mcp-tokens",
                json={"workspace_id": seeded["ws_a"], "name": "to-revoke"},
                headers=h,
            ).json()["data"]["id"]
            assert client.delete(f"/mcp-tokens/{tid}", headers=h).status_code == 204
            # 詳細 200、revoked_at != null
            g = client.get(f"/mcp-tokens/{tid}", headers=h)
            assert g.status_code == 200
            assert g.json()["data"]["revoked_at"] is not None
        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='mcp_token.revoke' and target_id=cast(:t as uuid)"
                ),
                {"t": tid},
            ).scalar_one()
        assert n == 1

    def test_revoke_member_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        # owner u_a が作成、member u_m が revoke 試行 → 403
        ha, hm = _h(seeded["u_a"]), _h(seeded["u_m"])
        with TestClient(app) as client:
            tid = client.post(
                "/mcp-tokens",
                json={"workspace_id": seeded["ws_a"], "name": "member-cant-revoke"},
                headers=ha,
            ).json()["data"]["id"]
            # member は token を閲覧できる
            assert client.get(f"/mcp-tokens/{tid}", headers=hm).status_code == 200
            # が revoke はできない (owner 限定)
            assert client.delete(f"/mcp-tokens/{tid}", headers=hm).status_code == 403

    def test_revoke_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            tid = client.post(
                "/mcp-tokens",
                json={"workspace_id": seeded["ws_a"], "name": "cross-ws"},
                headers=ha,
            ).json()["data"]["id"]
            # 別 WS owner からは token が不可視 → 404
            assert client.delete(f"/mcp-tokens/{tid}", headers=hb).status_code == 404
