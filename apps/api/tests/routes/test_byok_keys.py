"""Integration tests for /byok/keys (T-A-09) — 実 Postgres + RLS + JWT。実 DB 無なら skip。

本人のみ可視・編集可能 (RLS user_id=auth.uid())。plaintext key は登録時のみ
受け取り Fernet で暗号化して DB に保存、応答には含めない。decrypt は復元可。
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

# テスト用 Fernet key (32 byte の urlsafe-base64 = 44 文字)
from cryptography.fernet import Fernet  # noqa: E402

_TEST_FERNET_KEY = Fernet.generate_key().decode("ascii")
os.environ.setdefault("ATELIER_BYOK_ENCRYPTION_KEY", _TEST_FERNET_KEY)

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402
from src.services.byok_keys import _fernet, decrypt_key  # noqa: E402


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


@pytest.fixture(autouse=True)
def _ensure_fernet_cache() -> Iterator[None]:
    """テスト用 env を確実に有効化するため lru_cache をクリア。"""
    _fernet.cache_clear()
    yield
    _fernet.cache_clear()


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
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta09-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
    yield {"u_a": u_a, "u_b": u_b}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestByokKeys:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/byok/keys").status_code == 401

    def test_create_encrypts_and_response_excludes_plaintext(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        plaintext = "sk-test-1234567890ABCDEFGH"
        with TestClient(app) as client:
            r = client.post(
                "/byok/keys",
                json={"provider": "claude", "key": plaintext, "label": "primary"},
                headers=h,
            )
            assert r.status_code == 201, r.text
            body = r.json()["data"]
            # 応答に plaintext / encrypted_key は含まれない
            assert "key" not in body
            assert "encrypted_key" not in body
            assert body["provider"] == "claude"
            assert body["label"] == "primary"
            kid = body["id"]
        # DB には Fernet 暗号化文字列が保存 (plaintext と異なる)
        with sync_engine.connect() as c:
            row = c.execute(
                text("select encrypted_key from public.byok_api_keys where id = cast(:i as uuid)"),
                {"i": kid},
            ).first()
        assert row is not None
        stored = row[0]
        assert stored != plaintext
        # decrypt で復元可能
        assert decrypt_key(stored) == plaintext
        # audit_logs に記録
        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='byok_key.create' and target_id=cast(:t as uuid)"
                ),
                {"t": kid},
            ).scalar_one()
        assert n == 1

    def test_list_only_own_keys_and_filters(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            # u_a が 2 件 (claude active / openai inactive)、u_b が 1 件
            k1 = client.post(
                "/byok/keys",
                json={"provider": "claude", "key": "sk-a-claude"},
                headers=ha,
            ).json()["data"]["id"]
            k2 = client.post(
                "/byok/keys",
                json={"provider": "openai", "key": "sk-a-openai"},
                headers=ha,
            ).json()["data"]["id"]
            client.patch(f"/byok/keys/{k2}", json={"is_active": False}, headers=ha)
            client.post(
                "/byok/keys",
                json={"provider": "claude", "key": "sk-b-claude"},
                headers=hb,
            )
            # u_a の一覧: active のみ = k1 のみ
            lst = client.get("/byok/keys", headers=ha).json()["data"]
            assert {x["id"] for x in lst} == {k1}
            # include_inactive で 2 件
            lst2 = client.get("/byok/keys?include_inactive=true", headers=ha).json()["data"]
            assert {x["id"] for x in lst2} == {k1, k2}
            # provider filter
            cl = client.get("/byok/keys?provider=claude", headers=ha).json()["data"]
            assert {x["id"] for x in cl} == {k1}
            # u_b は別アカウントの key を見られない
            assert all(x["id"] != k1 for x in client.get("/byok/keys", headers=hb).json()["data"])

    def test_get_detail_and_cross_user_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            kid = client.post(
                "/byok/keys", json={"provider": "claude", "key": "sk"}, headers=ha
            ).json()["data"]["id"]
            assert client.get(f"/byok/keys/{kid}", headers=ha).status_code == 200
            # 別 user は 404 (RLS で 0 行)
            assert client.get(f"/byok/keys/{kid}", headers=hb).status_code == 404

    def test_update_label_and_active(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            kid = client.post(
                "/byok/keys",
                json={"provider": "gemini", "key": "sk", "label": "old"},
                headers=h,
            ).json()["data"]["id"]
            r = client.patch(
                f"/byok/keys/{kid}",
                json={"label": "new label", "is_active": False},
                headers=h,
            )
            assert r.status_code == 200
            assert r.json()["data"]["label"] == "new label"
            assert r.json()["data"]["is_active"] is False

    def test_delete_204_and_audit(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            kid = client.post(
                "/byok/keys", json={"provider": "claude", "key": "sk"}, headers=h
            ).json()["data"]["id"]
            assert client.delete(f"/byok/keys/{kid}", headers=h).status_code == 204
            assert client.get(f"/byok/keys/{kid}", headers=h).status_code == 404
        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='byok_key.delete' and target_id=cast(:t as uuid)"
                ),
                {"t": kid},
            ).scalar_one()
        assert n == 1

    def test_cross_user_delete_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            kid = client.post(
                "/byok/keys", json={"provider": "claude", "key": "sk"}, headers=ha
            ).json()["data"]["id"]
            assert client.delete(f"/byok/keys/{kid}", headers=hb).status_code == 404

    def test_invalid_provider_422(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.post(
                    "/byok/keys", json={"provider": "anthropic", "key": "x"}, headers=h
                ).status_code
                == 422
            )
