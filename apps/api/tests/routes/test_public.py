"""Integration tests for /public (T-A-44) — 実 Postgres + RLS + JWT。実 DB 無なら skip。

法令ページは anon (未認証) で閲覧可能、データ削除請求は本人 (authenticated) のみ。
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
from src.routes.public import get_public_session  # noqa: E402


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

    async def _override_rls_session(
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

    async def _override_public_session() -> AsyncGenerator[AsyncSession, None]:
        async with AsyncSession(test_engine) as session:
            await session.execute(text("set local role anon"))
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
    application.dependency_overrides[get_rls_session] = _override_rls_session
    application.dependency_overrides[get_public_session] = _override_public_session
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded_legal(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """テスト専用ロケール (zz) の現行法令ページを seed (運営側=superuser でのみ可)。"""
    doc_id = str(uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.legal_documents "
                "(id, doc_type, version, locale, title, body_md, effective_date, is_current) "
                "values (cast(:i as uuid), 'terms_of_service', 'v-test', 'zz', "
                " 'TEST 利用規約', '# test body', current_date, true)"
            ),
            {"i": doc_id},
        )
    yield {"doc_id": doc_id, "locale": "zz", "doc_type": "terms_of_service"}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.legal_documents where id = cast(:i as uuid)"), {"i": doc_id}
        )


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestPublicLegal:
    def test_list_legal_public_without_auth(
        self, app: FastAPI, seeded_legal: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            # 未認証でも 200 (公開ページ)
            r = client.get("/public/legal-documents", params={"locale": "zz"})
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            assert any(d["id"] == seeded_legal["doc_id"] for d in data)
            assert all(d["is_current"] for d in data)

    def test_get_legal_by_type_public(self, app: FastAPI, seeded_legal: dict[str, str]) -> None:
        with TestClient(app) as client:
            g = client.get("/public/legal-documents/terms_of_service", params={"locale": "zz"})
            assert g.status_code == 200, g.text
            assert g.json()["data"]["doc_type"] == "terms_of_service"
            assert g.json()["data"]["title"] == "TEST 利用規約"

    def test_get_legal_not_found_404(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            # 該当ロケールに現行版が無い → 404
            assert (
                client.get(
                    "/public/legal-documents/privacy_policy", params={"locale": "zz"}
                ).status_code
                == 404
            )

    def test_get_legal_invalid_type_422(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/public/legal-documents/not_a_doc_type").status_code == 422


@pytest.mark.integration
class TestDataDeletionRequest:
    def test_requires_auth_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert (
                client.post("/public/data-deletion-requests", json={"reason": "x"}).status_code
                == 401
            )

    def test_authenticated_request_recorded(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine
    ) -> None:
        uid = str(uuid.uuid4())
        with TestClient(app) as client:
            r = client.post(
                "/public/data-deletion-requests",
                json={"reason": "サービス利用を終了したため"},
                headers=_h(uid),
            )
            assert r.status_code == 201, r.text
            body = r.json()["data"]
            assert body["status"] == "received"
            req_id = body["request_id"]
        # audit_logs に本人の請求が記録される
        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='data_deletion.request' and target_id=cast(:t as uuid) "
                    "and actor_id=:a"
                ),
                {"t": req_id, "a": uid},
            ).scalar_one()
        assert n == 1
        with sync_engine.begin() as c:
            c.execute(
                text("delete from public.audit_logs where target_id = cast(:t as uuid)"),
                {"t": req_id},
            )
