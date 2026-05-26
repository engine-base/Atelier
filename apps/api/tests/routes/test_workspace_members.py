"""Integration tests for /workspaces/{id}/members (T-A-07) — 実 Postgres + RLS + JWT。

owner が email でメンバー招待 / ロール変更 / 削除。helper 関数 (definer) でメンバー詳細取得。
実 DB 無なら skip。
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
    """owner(A) + workspace A、招待対象の登録済 user(B)、無関係 user(C)。"""
    u_a, u_b, u_c = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    ws_a = str(uuid.uuid4())
    emails = {
        u_a: f"a-{u_a[:8]}@t.example",
        u_b: f"b-{u_b[:8]}@t.example",
        u_c: f"c-{u_c[:8]}@t.example",
    }
    with sync_engine.begin() as c:
        for uid, em in emails.items():
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email,display_name) values (:i,:e,:d)"),
                {"i": uid, "e": em, "d": f"U{uid[:4]}"},
            )
        # workspace A (owner membership は T-A-06 トリガ)
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws_a, "o": u_a, "n": f"ws-{ws_a[:6]}"},
        )
    yield {"u_a": u_a, "u_b": u_b, "u_c": u_c, "ws_a": ws_a, "email_b": emails[u_b]}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id = :w"), {"w": ws_a})
        c.execute(
            text("delete from public.users where id in (:a,:b,:c)"),
            {"a": u_a, "b": u_b, "c": u_c},
        )
        c.execute(
            text("delete from auth.users where id in (:a,:b,:c)"),
            {"a": u_a, "b": u_b, "c": u_c},
        )


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestWorkspaceMembers:
    def test_unauthenticated_401(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            assert client.get(f"/workspaces/{seeded['ws_a']}/members").status_code == 401

    def test_owner_invite_update_remove(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha = _h(seeded["u_a"])
        with TestClient(app) as client:
            # 初期は owner 1 名 (トリガ生成)
            members = client.get(f"/workspaces/{seeded['ws_a']}/members", headers=ha).json()["data"]
            assert len(members) == 1
            assert members[0]["role"] == "owner"

            # B を email で招待 (member)
            r = client.post(
                f"/workspaces/{seeded['ws_a']}/members",
                json={"email": seeded["email_b"], "role": "member"},
                headers=ha,
            )
            assert r.status_code == 201, r.text
            assert r.json()["data"]["user_id"] == seeded["u_b"]
            assert r.json()["data"]["role"] == "member"

            # 二重招待は 409
            assert (
                client.post(
                    f"/workspaces/{seeded['ws_a']}/members",
                    json={"email": seeded["email_b"], "role": "member"},
                    headers=ha,
                ).status_code
                == 409
            )

            # ロール変更 member→viewer
            pr = client.patch(
                f"/workspaces/{seeded['ws_a']}/members/{seeded['u_b']}",
                json={"role": "viewer"},
                headers=ha,
            )
            assert pr.status_code == 200
            assert pr.json()["data"]["role"] == "viewer"

            # 削除
            assert (
                client.delete(
                    f"/workspaces/{seeded['ws_a']}/members/{seeded['u_b']}", headers=ha
                ).status_code
                == 204
            )

    def test_invite_unregistered_email_422(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/workspaces/{seeded['ws_a']}/members",
                json={"email": "nobody@unregistered.example", "role": "member"},
                headers=ha,
            )
            assert r.status_code == 422

    def test_non_owner_cannot_invite_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        # user C は workspace A の member ですらない → members 一覧は 0 件、招待は forbidden
        hc = _h(seeded["u_c"])
        with TestClient(app) as client:
            assert (
                client.get(f"/workspaces/{seeded['ws_a']}/members", headers=hc).json()["data"] == []
            )
            r = client.post(
                f"/workspaces/{seeded['ws_a']}/members",
                json={"email": seeded["email_b"], "role": "member"},
                headers=hc,
            )
            assert r.status_code == 403
