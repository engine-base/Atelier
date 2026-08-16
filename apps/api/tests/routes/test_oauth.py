"""Integration tests for GAP-020 — OAuth サインイン (S-A01)。

/auth/oauth/providers・/auth/oauth/{provider}/start・/auth/oauth/{provider}/callback。
外部プロバイダ (Google / GitHub) は httpx.MockTransport で偽装し
(_http_client を monkeypatch)、DB は実 Postgres で account 連付けと
audit (auth.oauth_signin) を突合する。
"""
# pyright: reportPrivateUsage=false, reportFunctionMemberAccess=false, reportCallIssue=false, reportArgumentType=false

from __future__ import annotations

import hashlib
import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
os.environ.setdefault("ATELIER_DB_URL", PG_ASYNC)
# Supabase Admin API は無効化 (DB direct path を必ず通す)
os.environ.pop("ATELIER_SUPABASE_ADMIN_API_URL", None)
os.environ.pop("ATELIER_SUPABASE_SERVICE_ROLE_KEY", None)

import httpx  # noqa: E402
import sqlalchemy  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

API_BASE = "http://127.0.0.1:8000"
WEB_BASE = "http://localhost:3000"

_MIGRATION = (
    Path(__file__).resolve().parents[4] / "supabase" / "migrations" / "t-d-99zo_oauth_accounts.sql"
)


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
    pytest.mark.filterwarnings("ignore::ResourceWarning"),
    pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning"),
]


@pytest.fixture(scope="session", autouse=True)
def apply_migration() -> None:
    """t-d-99zo_oauth_accounts.sql を test DB に適用 (冪等)。"""
    if not _db_available():  # pragma: no cover
        return
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    try:
        with eng.connect() as c:
            c.execution_options(isolation_level="AUTOCOMMIT").exec_driver_sql(
                _MIGRATION.read_text(encoding="utf-8")
            )
    finally:
        eng.dispose()


@pytest.fixture()
def app() -> Iterator[FastAPI]:
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
    """テストが作成/使用した email を追跡し、users / audit_logs ごと掃除する。"""
    emails: list[str] = []
    yield emails
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    with eng.begin() as c:
        for em in emails:
            c.execute(
                text(
                    "delete from public.audit_logs where actor_id = :e or actor_id in "
                    "(select id::text from auth.users where email = :e)"
                ),
                {"e": em},
            )
            # oauth_accounts は users への FK on delete cascade で消える
            c.execute(
                text(
                    "delete from public.users where id in "
                    "(select id from auth.users where email = :e)"
                ),
                {"e": em},
            )
            c.execute(text("delete from auth.users where email = :e"), {"e": em})
    eng.dispose()


def _unset_all_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in (
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "GITHUB_OAUTH_CLIENT_ID",
        "GITHUB_OAUTH_CLIENT_SECRET",
    ):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture()
def oauth_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    """google / github 両プロバイダ有効 + base URL 明示。"""
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "g-client-id")
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "g-client-secret")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "gh-client-id")
    monkeypatch.setenv("GITHUB_OAUTH_CLIENT_SECRET", "gh-client-secret")
    monkeypatch.setenv("ATELIER_API_BASE_URL", API_BASE)
    monkeypatch.setenv("ATELIER_PUBLIC_BASE_URL", WEB_BASE)
    return monkeypatch


@pytest.fixture()
def fake_provider(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """httpx を monkeypatch した偽 Google / GitHub。

    返り値の dict を書き換えるとレスポンスを差し替えられる。
    """
    google_email = f"gap020-g-{uuid.uuid4().hex[:10]}@example.com"
    github_email = f"gap020-gh-{uuid.uuid4().hex[:10]}@example.com"
    canned: dict[str, Any] = {
        "google_email": google_email,
        "github_email": github_email,
        "token_response": {"access_token": "fake-provider-access-token"},
        "token_status": 200,
        "google_userinfo": {
            "sub": f"google-sub-{uuid.uuid4().hex[:8]}",
            "email": google_email,
            "email_verified": True,
            "name": "Google User",
        },
        "github_user": {"id": int(uuid.uuid4().int % 10**9), "login": "octo", "name": "Octo Cat"},
        "github_emails": [
            {"email": "secondary@example.com", "primary": False, "verified": True},
            {"email": github_email, "primary": True, "verified": True},
        ],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith("https://oauth2.googleapis.com/token") or url.startswith(
            "https://github.com/login/oauth/access_token"
        ):
            return httpx.Response(canned["token_status"], json=canned["token_response"])
        if url.startswith("https://openidconnect.googleapis.com/v1/userinfo"):
            return httpx.Response(200, json=canned["google_userinfo"])
        if url.startswith("https://api.github.com/user/emails"):
            return httpx.Response(200, json=canned["github_emails"])
        if url.startswith("https://api.github.com/user"):
            return httpx.Response(200, json=canned["github_user"])
        return httpx.Response(404, json={"error": "unexpected url in test"})

    from src.services.auth import oauth as oauth_mod

    monkeypatch.setattr(
        oauth_mod,
        "_http_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return canned


def _start_state(client: TestClient, provider: str) -> str:
    """/start の 302 先 URL から実際の署名 state を取り出す。"""
    r = client.get(f"/auth/oauth/{provider}/start", follow_redirects=False)
    assert r.status_code == 302, r.text
    query = parse_qs(urlsplit(r.headers["location"]).query)
    return query["state"][0]


def _seed_user(sync_engine: sqlalchemy.Engine, *, email: str, display_name: str) -> str:
    uid = str(uuid.uuid4())
    pw_hash = hashlib.sha256(b"seed-password-123").hexdigest()
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into auth.users (id, email, encrypted_password) "
                "values (cast(:i as uuid), :e, :p)"
            ),
            {"i": uid, "e": email, "p": pw_hash},
        )
        c.execute(
            text(
                "insert into public.users (id, email, display_name) "
                "values (cast(:i as uuid), :e, :d)"
            ),
            {"i": uid, "e": email, "d": display_name},
        )
    return uid


def _audit_rows(sync_engine: sqlalchemy.Engine, *, user_id: str) -> list[dict[str, Any]]:
    with sync_engine.begin() as c:
        rows = c.execute(
            text(
                "select after from public.audit_logs "
                "where action = 'auth.oauth_signin' and target_id = cast(:t as uuid) "
                "order by created_at"
            ),
            {"t": user_id},
        ).all()
    return [dict(r.after) for r in rows]


# --------------------------------------------------------------------------- #
# GET /auth/oauth/providers — env 追従
# --------------------------------------------------------------------------- #
@pytest.mark.integration
class TestOAuthProviders:
    def test_no_env_returns_empty_list(self, app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
        _unset_all_providers(monkeypatch)
        with TestClient(app) as client:
            r = client.get("/auth/oauth/providers")
            assert r.status_code == 200
            assert r.json()["data"] == []

    def test_google_only(self, app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
        _unset_all_providers(monkeypatch)
        monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "g-id")
        monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_SECRET", "g-secret")
        with TestClient(app) as client:
            data = client.get("/auth/oauth/providers").json()["data"]
            assert data == [{"id": "google", "display_name": "Google"}]

    def test_client_id_without_secret_stays_disabled(
        self, app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _unset_all_providers(monkeypatch)
        monkeypatch.setenv("GITHUB_OAUTH_CLIENT_ID", "gh-id")  # secret 無し = 無効
        with TestClient(app) as client:
            assert client.get("/auth/oauth/providers").json()["data"] == []

    def test_both_enabled(self, app: FastAPI, oauth_env: pytest.MonkeyPatch) -> None:
        with TestClient(app) as client:
            data = client.get("/auth/oauth/providers").json()["data"]
            assert data == [
                {"id": "github", "display_name": "GitHub"},
                {"id": "google", "display_name": "Google"},
            ]


# --------------------------------------------------------------------------- #
# GET /auth/oauth/{provider}/start — 302 と署名 state
# --------------------------------------------------------------------------- #
@pytest.mark.integration
class TestOAuthStart:
    def test_start_redirects_with_client_id_redirect_uri_and_signed_state(
        self, app: FastAPI, oauth_env: pytest.MonkeyPatch
    ) -> None:
        from src.services.auth import oauth as oauth_mod

        with TestClient(app) as client:
            r = client.get("/auth/oauth/google/start", follow_redirects=False)
            assert r.status_code == 302
            location = r.headers["location"]
            parts = urlsplit(location)
            assert location.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
            q = parse_qs(parts.query)
            assert q["client_id"] == ["g-client-id"]
            assert q["redirect_uri"] == [f"{API_BASE}/auth/oauth/google/callback"]
            assert q["response_type"] == ["code"]
            # state は ATELIER_AUTH_JWT_SECRET で署名済 → verify が通る
            oauth_mod.verify_state(q["state"][0], provider="google")

    def test_start_github(self, app: FastAPI, oauth_env: pytest.MonkeyPatch) -> None:
        with TestClient(app) as client:
            r = client.get("/auth/oauth/github/start", follow_redirects=False)
            assert r.status_code == 302
            q = parse_qs(urlsplit(r.headers["location"]).query)
            assert q["client_id"] == ["gh-client-id"]
            assert q["redirect_uri"] == [f"{API_BASE}/auth/oauth/github/callback"]

    def test_start_disabled_provider_503(
        self, app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _unset_all_providers(monkeypatch)
        with TestClient(app) as client:
            r = client.get("/auth/oauth/google/start", follow_redirects=False)
            assert r.status_code == 503

    def test_start_unknown_provider_422(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.get("/auth/oauth/facebook/start", follow_redirects=False)
            assert r.status_code == 422


# --------------------------------------------------------------------------- #
# GET /auth/oauth/{provider}/callback — 連付け 3 パターン + 失敗系
# --------------------------------------------------------------------------- #
@pytest.mark.integration
class TestOAuthCallback:
    def test_new_user_created_google(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        oauth_env: pytest.MonkeyPatch,
        fake_provider: dict[str, Any],
        created_emails: list[str],
    ) -> None:
        em = fake_provider["google_email"]
        created_emails.append(em)
        with TestClient(app) as client:
            state = _start_state(client, "google")
            r = client.get(
                f"/auth/oauth/google/callback?code=fake-code&state={state}",
                follow_redirects=False,
            )
            assert r.status_code == 302, r.text
            location = r.headers["location"]
            assert location.startswith(f"{WEB_BASE}/auth/oauth-complete#")
            frag = parse_qs(urlsplit(location).fragment)
            assert frag["email"] == [em]
            token = frag["access_token"][0]
            # 既存 signin と同一の JWT (decode_supabase_jwt で復号可能)
            from src.dependencies import decode_supabase_jwt

            cu = decode_supabase_jwt(token, os.environ["ATELIER_AUTH_JWT_SECRET"])
            assert cu.role == "authenticated"
        # DB: auth.users + public.users + oauth_accounts が作成される
        with sync_engine.begin() as c:
            u = c.execute(
                text("select id::text as uid, display_name from public.users where email = :e"),
                {"e": em},
            ).first()
            assert u is not None and u.display_name == "Google User"
            assert cu.id == u.uid
            oa = c.execute(
                text(
                    "select provider, provider_user_id, email from public.oauth_accounts "
                    "where user_id = cast(:u as uuid)"
                ),
                {"u": u.uid},
            ).first()
            assert oa is not None
            assert oa.provider == "google"
            assert oa.provider_user_id == fake_provider["google_userinfo"]["sub"]
            assert oa.email == em
        # audit: login_kind=created を DB 突合
        audits = _audit_rows(sync_engine, user_id=u.uid)
        assert [a["login_kind"] for a in audits] == ["created"]
        assert audits[0]["provider"] == "google"

    def test_existing_user_linked_by_email(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        oauth_env: pytest.MonkeyPatch,
        fake_provider: dict[str, Any],
        created_emails: list[str],
    ) -> None:
        em = fake_provider["github_email"]
        created_emails.append(em)
        uid = _seed_user(sync_engine, email=em, display_name="既存ユーザー")
        with TestClient(app) as client:
            state = _start_state(client, "github")
            r = client.get(
                f"/auth/oauth/github/callback?code=fake-code&state={state}",
                follow_redirects=False,
            )
            assert r.status_code == 302, r.text
            frag = parse_qs(urlsplit(r.headers["location"]).fragment)
            # 新規作成ではなく既存 user でログイン
            assert frag["user_id"] == [uid]
            assert frag["display_name"] == ["既存ユーザー"]
        with sync_engine.begin() as c:
            cnt = c.execute(
                text("select count(*) from public.users where email = :e"), {"e": em}
            ).scalar_one()
            assert cnt == 1  # 二重アカウントを作らない
            oa = c.execute(
                text(
                    "select provider_user_id from public.oauth_accounts "
                    "where user_id = cast(:u as uuid) and provider = 'github'"
                ),
                {"u": uid},
            ).first()
            assert oa is not None
            assert oa.provider_user_id == str(fake_provider["github_user"]["id"])
        audits = _audit_rows(sync_engine, user_id=uid)
        assert [a["login_kind"] for a in audits] == ["linked"]

    def test_existing_oauth_account_signs_in(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        oauth_env: pytest.MonkeyPatch,
        fake_provider: dict[str, Any],
        created_emails: list[str],
    ) -> None:
        em = fake_provider["github_email"]
        created_emails.append(em)
        uid = _seed_user(sync_engine, email=em, display_name="連付済ユーザー")
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.oauth_accounts "
                    "(user_id, provider, provider_user_id, email) "
                    "values (cast(:u as uuid), 'github', :pid, :e)"
                ),
                {"u": uid, "pid": str(fake_provider["github_user"]["id"]), "e": em},
            )
        with TestClient(app) as client:
            state = _start_state(client, "github")
            r = client.get(
                f"/auth/oauth/github/callback?code=fake-code&state={state}",
                follow_redirects=False,
            )
            assert r.status_code == 302, r.text
            frag = parse_qs(urlsplit(r.headers["location"]).fragment)
            assert frag["user_id"] == [uid]
        with sync_engine.begin() as c:
            cnt = c.execute(
                text("select count(*) from public.oauth_accounts where user_id = cast(:u as uuid)"),
                {"u": uid},
            ).scalar_one()
            assert cnt == 1  # 重複行を作らない
        audits = _audit_rows(sync_engine, user_id=uid)
        assert [a["login_kind"] for a in audits] == ["existing"]

    def test_tampered_state_400(
        self,
        app: FastAPI,
        oauth_env: pytest.MonkeyPatch,
        fake_provider: dict[str, Any],
    ) -> None:
        with TestClient(app) as client:
            state = _start_state(client, "google")
            payload, sig = state.split(".")
            tampered = f"{payload}x.{sig}"
            r = client.get(
                f"/auth/oauth/google/callback?code=fake-code&state={tampered}",
                follow_redirects=False,
            )
            assert r.status_code == 400
            # 別 provider の state 流用も 400
            gh_state = _start_state(client, "github")
            r2 = client.get(
                f"/auth/oauth/google/callback?code=fake-code&state={gh_state}",
                follow_redirects=False,
            )
            assert r2.status_code == 400

    def test_expired_state_400(
        self,
        app: FastAPI,
        oauth_env: pytest.MonkeyPatch,
        fake_provider: dict[str, Any],
    ) -> None:
        from src.services.auth import oauth as oauth_mod

        expired = oauth_mod.encode_state("google", ttl_seconds=-10)
        with TestClient(app) as client:
            r = client.get(
                f"/auth/oauth/google/callback?code=fake-code&state={expired}",
                follow_redirects=False,
            )
            assert r.status_code == 400

    def test_disabled_provider_callback_503(
        self, app: FastAPI, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _unset_all_providers(monkeypatch)
        with TestClient(app) as client:
            r = client.get("/auth/oauth/github/callback?code=x&state=y", follow_redirects=False)
            assert r.status_code == 503

    def test_github_unverified_email_400_creates_nothing(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        oauth_env: pytest.MonkeyPatch,
        fake_provider: dict[str, Any],
        created_emails: list[str],
    ) -> None:
        em = fake_provider["github_email"]
        created_emails.append(em)
        fake_provider["github_emails"] = [{"email": em, "primary": True, "verified": False}]
        with TestClient(app) as client:
            state = _start_state(client, "github")
            r = client.get(
                f"/auth/oauth/github/callback?code=fake-code&state={state}",
                follow_redirects=False,
            )
            assert r.status_code == 400
        with sync_engine.begin() as c:
            cnt = c.execute(
                text("select count(*) from public.users where email = :e"), {"e": em}
            ).scalar_one()
            assert cnt == 0  # 偽アカウントを作らない

    def test_google_unverified_email_400(
        self,
        app: FastAPI,
        oauth_env: pytest.MonkeyPatch,
        fake_provider: dict[str, Any],
    ) -> None:
        fake_provider["google_userinfo"]["email_verified"] = False
        with TestClient(app) as client:
            state = _start_state(client, "google")
            r = client.get(
                f"/auth/oauth/google/callback?code=fake-code&state={state}",
                follow_redirects=False,
            )
            assert r.status_code == 400

    def test_provider_error_param_redirects_with_error(
        self, app: FastAPI, oauth_env: pytest.MonkeyPatch
    ) -> None:
        with TestClient(app) as client:
            r = client.get(
                "/auth/oauth/google/callback?error=access_denied", follow_redirects=False
            )
            assert r.status_code == 302
            assert r.headers["location"] == f"{WEB_BASE}/auth/oauth-complete?error=access_denied"

    def test_exchange_failure_redirects_with_error(
        self,
        app: FastAPI,
        oauth_env: pytest.MonkeyPatch,
        fake_provider: dict[str, Any],
    ) -> None:
        fake_provider["token_status"] = 400
        fake_provider["token_response"] = {"error": "bad_verification_code"}
        with TestClient(app) as client:
            state = _start_state(client, "github")
            r = client.get(
                f"/auth/oauth/github/callback?code=bad&state={state}",
                follow_redirects=False,
            )
            assert r.status_code == 302
            assert r.headers["location"] == f"{WEB_BASE}/auth/oauth-complete?error=exchange_failed"
