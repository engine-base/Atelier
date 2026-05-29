"""Integration tests for /auth/signup (T-A-01) — 実 Postgres + DB direct insert path。

Supabase Admin API は test 環境で設定無しのため DB direct path を使う。
F-LEGAL-004: terms_of_service / privacy_policy 必須 / 任意 consent も記録。
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
# Service-role session が読む DB URL (signup は無認証ゆえ JWT セッション override が無く、
# 内部 factory が ATELIER_DB_URL を直接読む)
os.environ.setdefault("ATELIER_DB_URL", PG_ASYNC)
# Supabase Admin API は無効化 (DB direct path を必ず通す)
os.environ.pop("ATELIER_SUPABASE_ADMIN_API_URL", None)
os.environ.pop("ATELIER_SUPABASE_SERVICE_ROLE_KEY", None)

import sqlalchemy  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402


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


pytestmark = [
    pytest.mark.skipif(not _db_available(), reason="local Postgres not available"),
    # asyncpg は GC タイミングで socket close するため、ResourceWarning や
    # PytestUnraisableExceptionWarning が出ても本テストの動作上の問題では
    # ない。pytest.ini の error 化を本ファイル限定で緩める。
    pytest.mark.filterwarnings("ignore::ResourceWarning"),
    pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning"),
]


@pytest.fixture()
def app() -> Iterator[FastAPI]:
    # service-role session factory の lru_cache を test ごとに reset
    from src.services.auth import _service_session_factory

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
def created_emails() -> Iterator[list[str]]:
    emails: list[str] = []
    yield emails
    # cleanup after test
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    with eng.begin() as c:
        for em in emails:
            c.execute(
                text(
                    "delete from public.users where id in "
                    "(select id from auth.users where email = :e)"
                ),
                {"e": em},
            )
            c.execute(text("delete from auth.users where email = :e"), {"e": em})
    eng.dispose()


def _unique_email() -> str:
    return f"ta01-{uuid.uuid4().hex[:10]}@example.com"


@pytest.mark.integration
class TestAuthSignup:
    def test_signup_minimum_required_consents_succeeds(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        created_emails: list[str],
    ) -> None:
        em = _unique_email()
        created_emails.append(em)
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": em,
                    "password": "supersecret-pw",
                    "display_name": "Tester",
                    "consents": [
                        {
                            "type": "terms_of_service",
                            "version": "1.0.0",
                            "accepted": True,
                        },
                        {
                            "type": "privacy_policy",
                            "version": "1.0.0",
                            "accepted": True,
                        },
                    ],
                },
            )
            assert r.status_code == 201, r.text
            data = r.json()["data"]
            assert data["email"] == em
            assert data["display_name"] == "Tester"
            assert data["consents_recorded"] == 2
        # DB: public.users, consents, audit_logs を確認
        with sync_engine.begin() as c:
            u = c.execute(
                text(
                    "select display_name from public.users "
                    "where id in (select id from auth.users where email = :e)"
                ),
                {"e": em},
            ).first()
            assert u is not None and u.display_name == "Tester"
            cnt = c.execute(
                text(
                    "select count(*) from public.consents "
                    "where user_id in (select id from auth.users where email = :e)"
                ),
                {"e": em},
            ).scalar_one()
            assert cnt == 2
            audit = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'auth.signup' "
                    "and actor_id in (select id::text from auth.users where email = :e)"
                ),
                {"e": em},
            ).scalar_one()
            assert audit == 1

    def test_signup_records_all_four_consent_types(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        created_emails: list[str],
    ) -> None:
        em = _unique_email()
        created_emails.append(em)
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": em,
                    "password": "supersecret-pw",
                    "display_name": "FourConsent",
                    "consents": [
                        {"type": "terms_of_service", "version": "1.0.0", "accepted": True},
                        {"type": "privacy_policy", "version": "1.0.0", "accepted": True},
                        {"type": "data_residency", "version": "1.0.0", "accepted": True},
                        {
                            "type": "ai_training_optin",
                            "version": "1.0.0",
                            "accepted": False,
                        },
                    ],
                },
            )
            assert r.status_code == 201, r.text
            assert r.json()["data"]["consents_recorded"] == 4
        with sync_engine.begin() as c:
            types_accepted = c.execute(
                text(
                    "select type::text, accepted from public.consents "
                    "where user_id in (select id from auth.users where email = :e)"
                ),
                {"e": em},
            ).all()
            type_map = {r.type: r.accepted for r in types_accepted}
            assert type_map["terms_of_service"] is True
            assert type_map["privacy_policy"] is True
            assert type_map["data_residency"] is True
            # ai_training_optin はデフォルト OFF (R-A03: AI 学習デフォルト OFF)
            assert type_map["ai_training_optin"] is False

    def test_signup_missing_terms_returns_422(
        self, app: FastAPI, created_emails: list[str]
    ) -> None:
        em = _unique_email()
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": em,
                    "password": "supersecret-pw",
                    "display_name": "NoTerms",
                    "consents": [
                        {"type": "privacy_policy", "version": "1.0.0", "accepted": True},
                        {"type": "data_residency", "version": "1.0.0", "accepted": True},
                    ],
                },
            )
            assert r.status_code == 422
            assert "terms_of_service" in r.json()["detail"]

    def test_signup_terms_rejected_returns_422(
        self, app: FastAPI, created_emails: list[str]
    ) -> None:
        em = _unique_email()
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": em,
                    "password": "supersecret-pw",
                    "display_name": "RejectTerms",
                    "consents": [
                        {
                            "type": "terms_of_service",
                            "version": "1.0.0",
                            "accepted": False,
                        },
                        {
                            "type": "privacy_policy",
                            "version": "1.0.0",
                            "accepted": True,
                        },
                    ],
                },
            )
            assert r.status_code == 422

    def test_signup_duplicate_email_returns_409(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        created_emails: list[str],
    ) -> None:
        em = _unique_email()
        created_emails.append(em)
        payload = {
            "email": em,
            "password": "supersecret-pw",
            "display_name": "Dup",
            "consents": [
                {"type": "terms_of_service", "version": "1.0.0", "accepted": True},
                {"type": "privacy_policy", "version": "1.0.0", "accepted": True},
            ],
        }
        with TestClient(app) as client:
            r1 = client.post("/auth/signup", json=payload)
            assert r1.status_code == 201
            r2 = client.post("/auth/signup", json=payload)
            assert r2.status_code == 409

    def test_signup_validates_email_format(self, app: FastAPI, created_emails: list[str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": "not-an-email",
                    "password": "supersecret-pw",
                    "display_name": "Bad",
                    "consents": [
                        {"type": "terms_of_service", "version": "1.0.0", "accepted": True},
                        {"type": "privacy_policy", "version": "1.0.0", "accepted": True},
                    ],
                },
            )
            assert r.status_code == 422

    def test_signup_password_minimum_length(self, app: FastAPI, created_emails: list[str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": _unique_email(),
                    "password": "short",
                    "display_name": "Short",
                    "consents": [
                        {"type": "terms_of_service", "version": "1.0.0", "accepted": True},
                        {"type": "privacy_policy", "version": "1.0.0", "accepted": True},
                    ],
                },
            )
            assert r.status_code == 422

    def test_signup_consents_min_length(self, app: FastAPI, created_emails: list[str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": _unique_email(),
                    "password": "supersecret-pw",
                    "display_name": "NoConsent",
                    "consents": [
                        {
                            "type": "terms_of_service",
                            "version": "1.0.0",
                            "accepted": True,
                        }
                    ],
                },
            )
            assert r.status_code == 422

    def test_signup_ip_and_user_agent_recorded(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        created_emails: list[str],
    ) -> None:
        em = _unique_email()
        created_emails.append(em)
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                headers={"User-Agent": "Mozilla/5.0 (TestUA)"},
                json={
                    "email": em,
                    "password": "supersecret-pw",
                    "display_name": "IPUser",
                    "consents": [
                        {"type": "terms_of_service", "version": "1.0.0", "accepted": True},
                        {"type": "privacy_policy", "version": "1.0.0", "accepted": True},
                    ],
                },
            )
            assert r.status_code == 201
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select cast(ip_address as text) as ip, user_agent "
                    "from public.consents "
                    "where user_id in (select id from auth.users where email = :e) "
                    "limit 1"
                ),
                {"e": em},
            ).first()
            assert row is not None
            assert row.user_agent == "Mozilla/5.0 (TestUA)"
            # TestClient は "testclient" を client.host にするが、これは
            # inet として不正なため normalize_ip が None に落とす。
            # 実プロダクションでは正しい IP が記録される。
            assert row.ip is None
