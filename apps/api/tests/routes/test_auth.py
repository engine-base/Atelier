"""Integration tests for /auth/signup (T-A-01) — 実 Postgres + DB direct insert path。

Supabase Admin API は test 環境で設定無しのため DB direct path を使う。
F-LEGAL-004: terms_of_service / privacy_policy 必須 / 任意 consent も記録。
"""
# pyright: reportPrivateUsage=false, reportFunctionMemberAccess=false, reportCallIssue=false, reportArgumentType=false

from __future__ import annotations

import hashlib
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


def _current_legal_versions() -> dict[str, str]:
    """postgres 側の現行法務版を読む (GAP-235: signup は同意版が現行版と一致を要求)。"""
    out = {"terms_of_service": "1.0.0", "privacy_policy": "1.0.0"}
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                for row in c.execute(
                    text(
                        "select doc_type, version from public.legal_documents "
                        "where is_current and doc_type in "
                        "('terms_of_service','privacy_policy')"
                    )
                ):
                    out[str(row.doc_type)] = str(row.version)
        finally:
            eng.dispose()
    except Exception:
        pass
    return out


_LEGAL_V = _current_legal_versions()
_TERMS_V = _LEGAL_V["terms_of_service"]
_PRIVACY_V = _LEGAL_V["privacy_policy"]


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
    # GAP-197: engine はプロセスに 1 つ。テストは loop 毎に作り直すのでここで捨てる。
    from src.db.session import reset_shared_engine_cache

    reset_shared_engine_cache()
    from src.routes import api_router

    application = FastAPI()
    application.include_router(api_router)
    yield application
    reset_shared_engine_cache()


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
                            "version": _TERMS_V,
                            "accepted": True,
                        },
                        {
                            "type": "privacy_policy",
                            "version": _PRIVACY_V,
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
                        {"type": "terms_of_service", "version": _TERMS_V, "accepted": True},
                        {"type": "privacy_policy", "version": _PRIVACY_V, "accepted": True},
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
                        {"type": "privacy_policy", "version": _PRIVACY_V, "accepted": True},
                        {"type": "data_residency", "version": "1.0.0", "accepted": True},
                    ],
                },
            )
            assert r.status_code == 422
            # GAP-216: 画面に出る文言なので内部名 (terms_of_service) は載せない。
            # 「どの同意が足りないか」という情報は日本語の文書名で残す。
            detail = r.json()["detail"]
            assert "利用規約" in detail
            assert "terms_of_service" not in detail

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
                            "version": _TERMS_V,
                            "accepted": False,
                        },
                        {
                            "type": "privacy_policy",
                            "version": _PRIVACY_V,
                            "accepted": True,
                        },
                    ],
                },
            )
            assert r.status_code == 422

    def test_signup_invalid_consent_version_returns_422_not_500(
        self, app: FastAPI, created_emails: list[str]
    ) -> None:
        """バグ #25 回帰: 不正 version は DB CHECK に達する前に 422 で弾く (旧: 500)。"""
        em = _unique_email()
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": em,
                    "password": "supersecret-pw",
                    "display_name": "BadVersion",
                    "consents": [
                        {"type": "terms_of_service", "version": "v1", "accepted": True},
                        {"type": "privacy_policy", "version": _PRIVACY_V, "accepted": True},
                    ],
                },
            )
            assert r.status_code == 422
            assert r.status_code != 500

    def test_signup_consent_version_must_be_current(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, created_emails: list[str]
    ) -> None:
        """GAP-235: 同意の版が現行版と食い違うと 409 で止め、記録も作らない。

        同意記録は法的な証跡なので、対象が現行の公開文書であることを
        サーバー側で裏取りする。クライアントの申告 (実在しない/古い版) を
        鵜呑みにして「何に同意したのか分からない記録」を残さない。
        """
        em = _unique_email()
        created_emails.append(em)
        with TestClient(app) as client:
            r = client.post(
                "/auth/signup",
                json={
                    "email": em,
                    "password": "supersecret-pw",
                    "display_name": "StaleConsent",
                    # 形式は正しいが現行版ではない (画面が古い / 非 UI クライアント)
                    "consents": [
                        {"type": "terms_of_service", "version": "1999-01-01", "accepted": True},
                        {"type": "privacy_policy", "version": "1999-01-01", "accepted": True},
                    ],
                },
            )
            assert r.status_code == 409, r.text
            # 内部名や英語ではなく、次の行動 (再読込) が分かる日本語
            detail = r.json()["detail"]
            assert "terms_of_service" not in detail
            assert "再読み込み" in detail
        # 記録を作らない (ユーザーも consents も残らない)
        with sync_engine.begin() as c:
            exists = c.execute(text("select 1 from auth.users where email = :e"), {"e": em}).first()
            assert exists is None

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
                {"type": "terms_of_service", "version": _TERMS_V, "accepted": True},
                {"type": "privacy_policy", "version": _PRIVACY_V, "accepted": True},
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
                        {"type": "terms_of_service", "version": _TERMS_V, "accepted": True},
                        {"type": "privacy_policy", "version": _PRIVACY_V, "accepted": True},
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
                        {"type": "terms_of_service", "version": _TERMS_V, "accepted": True},
                        {"type": "privacy_policy", "version": _PRIVACY_V, "accepted": True},
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
                            "version": _TERMS_V,
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
                        {"type": "terms_of_service", "version": _TERMS_V, "accepted": True},
                        {"type": "privacy_policy", "version": _PRIVACY_V, "accepted": True},
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


# --------------------------------------------------------------------------- #
# T-A-02: signin + 5 回失敗ロック
# --------------------------------------------------------------------------- #
@pytest.fixture()
def signin_user(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """signin 用に encrypted_password 付きユーザーを seed。

    stub auth.users に encrypted_password 列を足す (本番 Supabase auth.users
    は元々この列を持つ。ここでは test stub に mirror する)。
    """
    uid = str(uuid.uuid4())
    em = f"ta02-{uuid.uuid4().hex[:10]}@example.com"
    pw = "correct-horse-battery"
    pw_hash = hashlib.sha256(pw.encode("utf-8")).hexdigest()
    with sync_engine.begin() as c:
        c.execute(text("alter table auth.users add column if not exists encrypted_password text"))
        c.execute(
            text(
                "insert into auth.users (id, email, encrypted_password) "
                "values (cast(:i as uuid), :e, :p)"
            ),
            {"i": uid, "e": em, "p": pw_hash},
        )
        c.execute(
            text(
                "insert into public.users (id, email, display_name) "
                "values (cast(:i as uuid), :e, 'SigninUser')"
            ),
            {"i": uid, "e": em},
        )
    yield {"user_id": uid, "email": em, "password": pw}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.audit_logs where actor_id = :e"), {"e": em})
        c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": uid})
        c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": uid})


@pytest.mark.integration
class TestAuthSignin:
    def test_signin_success_returns_jwt(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        signin_user: dict[str, str],
    ) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/signin",
                json={"email": signin_user["email"], "password": signin_user["password"]},
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["token_type"] == "bearer"
            assert d["user_id"] == signin_user["user_id"]
            assert d["email"] == signin_user["email"]
            assert d["display_name"] == "SigninUser"
            assert len(d["access_token"].split(".")) == 3
        # audit: auth.signin 記録
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'auth.signin' and target_id = cast(:i as uuid)"
                ),
                {"i": signin_user["user_id"]},
            ).scalar_one()
            assert cnt == 1

    def test_signin_jwt_is_decodable_by_dependency(
        self, app: FastAPI, signin_user: dict[str, str]
    ) -> None:
        """発行 JWT が get_current_user で復号できる (保護 endpoint で使える)。"""
        from src.dependencies import decode_supabase_jwt

        with TestClient(app) as client:
            r = client.post(
                "/auth/signin",
                json={"email": signin_user["email"], "password": signin_user["password"]},
            )
            token = r.json()["data"]["access_token"]
        secret = os.environ["ATELIER_AUTH_JWT_SECRET"]
        cu = decode_supabase_jwt(token, secret)
        assert cu.id == signin_user["user_id"]
        assert cu.role == "authenticated"

    def test_signin_wrong_password_401_and_audits_failure(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        signin_user: dict[str, str],
    ) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/signin",
                json={"email": signin_user["email"], "password": "wrong-pw"},
            )
            assert r.status_code == 401
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'auth.signin_failed' and actor_id = :e"
                ),
                {"e": signin_user["email"]},
            ).scalar_one()
            assert cnt == 1

    def test_signin_unknown_email_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/signin",
                json={"email": "nobody@example.com", "password": "whatever-pw"},
            )
            assert r.status_code == 401

    def test_signin_locks_after_5_failures(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        signin_user: dict[str, str],
    ) -> None:
        with TestClient(app) as client:
            # 5 回失敗
            for _ in range(5):
                r = client.post(
                    "/auth/signin",
                    json={"email": signin_user["email"], "password": "wrong-pw"},
                )
                assert r.status_code == 401
            # 6 回目は正しい password でも 429 ロック
            r6 = client.post(
                "/auth/signin",
                json={"email": signin_user["email"], "password": signin_user["password"]},
            )
            assert r6.status_code == 429
        with sync_engine.begin() as c:
            locked = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'auth.signin_locked' and actor_id = :e"
                ),
                {"e": signin_user["email"]},
            ).scalar_one()
            assert locked >= 1

    def test_signin_lock_blocks_correct_password(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        signin_user: dict[str, str],
    ) -> None:
        """ロック後は正しい credential でも入れない (5 回失敗 → lock 維持)。"""
        with TestClient(app) as client:
            for _ in range(5):
                client.post(
                    "/auth/signin",
                    json={"email": signin_user["email"], "password": "x"},
                )
            r = client.post(
                "/auth/signin",
                json={"email": signin_user["email"], "password": signin_user["password"]},
            )
            assert r.status_code == 429

    def test_signin_validates_email_format(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post("/auth/signin", json={"email": "bad", "password": "whatever"})
            assert r.status_code == 422

    def test_signin_soft_deleted_user_403_says_pending_deletion(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        signin_user: dict[str, str],
    ) -> None:
        """GAP-269 (通し J52-03): 退会中 + 正しいパスワード → 「退会手続き中」(403)。

        「パスワードが違う」(401) だと本人が復元導線にたどり着けない。
        パスワードが違う場合は従来通り 401 のまま (存在を漏らさない)。"""
        with sync_engine.begin() as c:
            c.execute(
                text("update public.users set deleted_at = now() where id = cast(:i as uuid)"),
                {"i": signin_user["user_id"]},
            )
        with TestClient(app) as client:
            r = client.post(
                "/auth/signin",
                json={"email": signin_user["email"], "password": signin_user["password"]},
            )
            assert r.status_code == 403, r.text
            assert "退会手続き中" in r.json()["detail"]
            assert "復元" in r.json()["detail"]
            bad = client.post(
                "/auth/signin",
                json={"email": signin_user["email"], "password": "wrong-password-xx"},
            )
            assert bad.status_code == 401
            assert "退会" not in bad.json()["detail"]


# --------------------------------------------------------------------------- #
# T-A-03 / T-A-04 / T-A-05 共通: 認証フロー用 fixture
# --------------------------------------------------------------------------- #
import json as _json  # noqa: E402


@pytest.fixture()
def auth_user(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """T-A-03〜05 用 user。encrypted_password 列を auth.users に確保し seed。"""
    uid = str(uuid.uuid4())
    em = f"ta03-{uuid.uuid4().hex[:10]}@example.com"
    pw = "init-password-12345"
    pw_hash = hashlib.sha256(pw.encode("utf-8")).hexdigest()
    with sync_engine.begin() as c:
        c.execute(text("alter table auth.users add column if not exists encrypted_password text"))
        c.execute(
            text(
                "insert into auth.users (id, email, encrypted_password) "
                "values (cast(:i as uuid), :e, :p)"
            ),
            {"i": uid, "e": em, "p": pw_hash},
        )
        c.execute(
            text(
                "insert into public.users (id, email, display_name) "
                "values (cast(:i as uuid), :e, 'AuthUser')"
            ),
            {"i": uid, "e": em},
        )
    yield {"user_id": uid, "email": em, "password": pw}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.audit_logs where actor_id in (:e, :u)"),
            {"e": em, "u": uid},
        )
        c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": uid})
        c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": uid})


def _seed_audit_token(
    sync_engine: sqlalchemy.Engine,
    *,
    action: str,
    email: str,
    extra: dict[str, object] | None = None,
    ttl_seconds: int = 600,
) -> tuple[str, str]:
    """audit_logs に発行済 token を inject し (plain, target_id) を返す。"""
    import time as _time

    from src.services.auth import _new_opaque_token

    plain, h = _new_opaque_token()
    target_id = str(uuid.uuid4())
    after = {
        "email": email,
        "token_hash": h,
        "expires_epoch": int(_time.time()) + ttl_seconds,
    }
    if extra:
        after.update(extra)
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.audit_logs "
                "(actor_type, actor_id, action, target_type, target_id, after) "
                "values ('anonymous', :e, :a, 'auth_token', "
                "cast(:t as uuid), cast(:j as jsonb))"
            ),
            {"e": email, "a": action, "t": target_id, "j": _json.dumps(after)},
        )
    return plain, target_id


# --------------------------------------------------------------------------- #
# T-A-03: Magic Link + OAuth
# --------------------------------------------------------------------------- #
@pytest.mark.integration
class TestMagicLink:
    def test_request_returns_202_always(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post("/auth/magic-link/request", json={"email": "unknown@example.com"})
            assert r.status_code == 202
            assert r.json()["data"]["accepted"] is True

    def test_request_records_token_audit(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        with TestClient(app) as client:
            r = client.post("/auth/magic-link/request", json={"email": auth_user["email"]})
            assert r.status_code == 202
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'auth.magic_link.issued' and actor_id = :e"
                ),
                {"e": auth_user["email"]},
            ).scalar_one()
            assert cnt >= 1

    def test_verify_invalid_token_401(self, app: FastAPI, auth_user: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/magic-link/verify",
                json={"email": auth_user["email"], "token": "x" * 40},
            )
            assert r.status_code == 401

    def test_verify_full_roundtrip_returns_jwt(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        plain, _ = _seed_audit_token(
            sync_engine, action="auth.magic_link.issued", email=auth_user["email"]
        )
        with TestClient(app) as client:
            r = client.post(
                "/auth/magic-link/verify",
                json={"email": auth_user["email"], "token": plain},
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["user_id"] == auth_user["user_id"]
            assert d["refresh_token"] is not None
            from src.dependencies import decode_supabase_jwt

            cu = decode_supabase_jwt(d["access_token"], os.environ["ATELIER_AUTH_JWT_SECRET"])
            assert cu.id == auth_user["user_id"]

    def test_verify_token_can_only_be_used_once(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        plain, _ = _seed_audit_token(
            sync_engine, action="auth.magic_link.issued", email=auth_user["email"]
        )
        with TestClient(app) as client:
            r1 = client.post(
                "/auth/magic-link/verify",
                json={"email": auth_user["email"], "token": plain},
            )
            assert r1.status_code == 200
            r2 = client.post(
                "/auth/magic-link/verify",
                json={"email": auth_user["email"], "token": plain},
            )
            assert r2.status_code == 401

    def test_oauth_redirect_google(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.get("/auth/oauth/google/redirect-url")
            assert r.status_code == 200
            d = r.json()["data"]
            assert "accounts.google.com" in d["authorize_url"]
            assert d["state"]
            assert d["provider"] == "google"

    def test_oauth_redirect_github(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.get("/auth/oauth/github/redirect-url")
            assert r.status_code == 200
            assert "github.com" in r.json()["data"]["authorize_url"]

    def test_oauth_unknown_provider_422(self, app: FastAPI) -> None:
        # provider は Literal['google','github'] のため、それ以外は Pydantic validation 422
        with TestClient(app) as client:
            r = client.get("/auth/oauth/facebook/redirect-url")
            assert r.status_code == 422


# --------------------------------------------------------------------------- #
# T-A-04: Password Reset + Refresh
# --------------------------------------------------------------------------- #
@pytest.mark.integration
class TestPasswordResetAndRefresh:
    def test_reset_request_always_202(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post("/auth/password-reset/request", json={"email": "nobody@example.com"})
            assert r.status_code == 202

    def test_reset_invalid_token_401(self, app: FastAPI, auth_user: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/password-reset/confirm",
                json={
                    "email": auth_user["email"],
                    "token": "z" * 40,
                    "new_password": "new-strong-password-9876",
                },
            )
            assert r.status_code == 401

    def test_reset_full_roundtrip(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        plain, _ = _seed_audit_token(
            sync_engine, action="auth.password_reset.issued", email=auth_user["email"]
        )
        new_pw = "new-secret-password-789"
        with TestClient(app) as client:
            r = client.post(
                "/auth/password-reset/confirm",
                json={
                    "email": auth_user["email"],
                    "token": plain,
                    "new_password": new_pw,
                },
            )
            assert r.status_code == 200, r.text
            # 旧 password 失敗 / 新 password 成功
            assert (
                client.post(
                    "/auth/signin",
                    json={"email": auth_user["email"], "password": auth_user["password"]},
                ).status_code
                == 401
            )
            assert (
                client.post(
                    "/auth/signin",
                    json={"email": auth_user["email"], "password": new_pw},
                ).status_code
                == 200
            )

    def test_password_change_revokes_refresh_tokens(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        """GAP-209 回帰: **パスワードを変えたら古い refresh token は死ぬ**。

        照合 SQL の `after` が修飾されておらず内側の別行に解決されていたため、
        `auth.refresh.revoked_all` を書いても失効が一切効いていなかった。
        乗っ取られてパスワードを変えても、盗まれた token がそのまま使えた。
        """
        refresh, _ = _seed_audit_token(
            sync_engine,
            action="auth.refresh.issued",
            email=auth_user["email"],
            extra={"user_id": auth_user["user_id"], "origin": "test"},
            ttl_seconds=86400,
        )
        reset, _ = _seed_audit_token(
            sync_engine, action="auth.password_reset.issued", email=auth_user["email"]
        )
        with TestClient(app) as client:
            # 失効前は通る (土台の確認)
            assert client.post("/auth/refresh", json={"refresh_token": refresh}).status_code == 200
            refreshed, _ = _seed_audit_token(
                sync_engine,
                action="auth.refresh.issued",
                email=auth_user["email"],
                extra={"user_id": auth_user["user_id"], "origin": "test"},
                ttl_seconds=86400,
            )
            r = client.post(
                "/auth/password-reset/confirm",
                json={
                    "email": auth_user["email"],
                    "token": reset,
                    "new_password": "another-strong-password-4321",
                },
            )
            assert r.status_code == 200, r.text
            after = client.post("/auth/refresh", json={"refresh_token": refreshed})
            assert after.status_code == 401, after.text

    def test_refresh_rotates_token(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        plain, _ = _seed_audit_token(
            sync_engine,
            action="auth.refresh.issued",
            email=auth_user["email"],
            extra={"user_id": auth_user["user_id"], "origin": "test"},
            ttl_seconds=86400,
        )
        with TestClient(app) as client:
            r = client.post("/auth/refresh", json={"refresh_token": plain})
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["access_token"]
            assert d["refresh_token"] != plain
            # 古い token は失効
            r2 = client.post("/auth/refresh", json={"refresh_token": plain})
            assert r2.status_code == 401

    def test_refresh_invalid_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post("/auth/refresh", json={"refresh_token": "y" * 40})
            assert r.status_code == 401


# --------------------------------------------------------------------------- #
# T-A-05: 退会 (30 日猶予, F-LEGAL-002)
# --------------------------------------------------------------------------- #
def _make_jwt(user_id: str) -> str:
    import base64 as _b64
    import hmac as _hmac
    import time as _time

    secret = os.environ["ATELIER_AUTH_JWT_SECRET"]
    header = (
        _b64.urlsafe_b64encode(_json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
        .rstrip(b"=")
        .decode()
    )
    payload = (
        _b64.urlsafe_b64encode(
            _json.dumps(
                {
                    "sub": user_id,
                    "role": "authenticated",
                    "aud": "authenticated",
                    "exp": int(_time.time()) + 3600,
                }
            ).encode()
        )
        .rstrip(b"=")
        .decode()
    )
    sig = (
        _b64.urlsafe_b64encode(
            _hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
        )
        .rstrip(b"=")
        .decode()
    )
    return f"{header}.{payload}.{sig}"


@pytest.mark.integration
class TestAccountDeletionAndRestore:
    def test_delete_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post("/auth/account/delete", json={"password": "x"})
            assert r.status_code == 401

    def test_delete_wrong_password_401(self, app: FastAPI, auth_user: dict[str, str]) -> None:
        h = {"Authorization": f"Bearer {_make_jwt(auth_user['user_id'])}"}
        with TestClient(app) as client:
            r = client.post("/auth/account/delete", headers=h, json={"password": "WRONG-PW"})
            assert r.status_code == 401

    def test_existing_sessions_stop_working_after_delete(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        """GAP-245: 退会したら、発行済みの JWT と Bridge トークンはその場で使えなくなる。

        本番実測: 退会 (200) 後も同じ JWT で GET /workspaces が 200・チャット実行まで
        通っていた。signin は 401 (存在秘匿) なのに、既存のセッションだけ生き残る
        (盗まれたトークンも退会で切れない)。
        """
        from src import dependencies

        h = {"Authorization": f"Bearer {_make_jwt(auth_user['user_id'])}"}
        # GAP-309: 本人が発行した成果物の共有リンクも退会で失効する
        ws, proj, out, link = (str(uuid.uuid4()) for _ in range(4))
        with sync_engine.begin() as c:
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": auth_user["user_id"], "n": "g309"},
            )
            c.execute(
                text(
                    "insert into public.projects (id,workspace_id,name,project_type) "
                    "values (:i,:w,:n,'internal_product')"
                ),
                {"i": proj, "w": ws, "n": "g309"},
            )
            c.execute(
                text(
                    "insert into public.workflow_outputs (id,project_id,stage,version,html_path) "
                    "values (cast(:i as uuid),cast(:p as uuid),'proposal',1,'g309.html')"
                ),
                {"i": out, "p": proj},
            )
            c.execute(
                text(
                    "insert into public.output_share_links "
                    "(id,output_id,token_hash,label,expires_at,created_by) "
                    "values (cast(:i as uuid),cast(:o as uuid),:h,'g309',now() + interval '7 days',"
                    " cast(:u as uuid))"
                ),
                {"i": link, "o": out, "h": "g309" * 16, "u": auth_user["user_id"]},
            )
        with TestClient(app) as client:
            # 退会前: 通る + Bridge トークンも発行できる
            assert client.get("/workspaces", headers=h).status_code == 200
            raw = client.post("/bridge-tokens", json={}, headers=h).json()["data"]["token"]
            assert (
                client.post(
                    "/chat-relay/pick",
                    json={"worker_id": "g245"},
                    headers={"X-Bridge-Token": raw},
                ).status_code
                == 200
            )
            r = client.post(
                "/auth/account/delete", headers=h, json={"password": auth_user["password"]}
            )
            assert r.status_code == 200, r.text
            # 退会後: 期限内の JWT でも 401 (キャッシュを待たず即座に)
            assert client.get("/workspaces", headers=h).status_code == 401
            assert client.get("/projects", headers=h).status_code == 401
            # Bridge トークンも失効している
            assert (
                client.post(
                    "/chat-relay/pick",
                    json={"worker_id": "g245"},
                    headers={"X-Bridge-Token": raw},
                ).status_code
                == 401
            )
        # GAP-309: 共有リンクは revoked_at が立つ
        with sync_engine.begin() as c:
            revoked = c.execute(
                text(
                    "select revoked_at from public.output_share_links where id = cast(:i as uuid)"
                ),
                {"i": link},
            ).scalar_one()
            assert revoked is not None
            c.execute(text("delete from public.workspaces where id = :i"), {"i": ws})
            # 復活すれば同じ JWT が (期限内なら) また通る
            rr = client.post(
                "/auth/account/restore",
                json={"email": auth_user["email"], "password": auth_user["password"]},
            )
            assert rr.status_code == 200, rr.text
            assert client.get("/workspaces", headers=h).status_code == 200
        dependencies.forget_active_user(auth_user["user_id"])
        with sync_engine.begin() as c:
            c.execute(
                text("delete from public.bridge_user_tokens where user_id = cast(:i as uuid)"),
                {"i": auth_user["user_id"]},
            )

    def test_delete_succeeds(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        h = {"Authorization": f"Bearer {_make_jwt(auth_user['user_id'])}"}
        with TestClient(app) as client:
            r = client.post(
                "/auth/account/delete",
                headers=h,
                json={"password": auth_user["password"], "reason": "test"},
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["user_id"] == auth_user["user_id"]
            assert d["scheduled_purge_at"] > d["deleted_at"]
        with sync_engine.begin() as c:
            row = c.execute(
                text("select deleted_at from public.users where id = cast(:i as uuid)"),
                {"i": auth_user["user_id"]},
            ).first()
            assert row is not None and row.deleted_at is not None
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'auth.account.deleted' and target_id = cast(:t as uuid)"
                ),
                {"t": auth_user["user_id"]},
            ).scalar_one()
            assert cnt == 1

    def test_restore_within_window(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        with sync_engine.begin() as c:
            c.execute(
                text("update public.users set deleted_at = now() where id = cast(:i as uuid)"),
                {"i": auth_user["user_id"]},
            )
        with TestClient(app) as client:
            r = client.post(
                "/auth/account/restore",
                json={"email": auth_user["email"], "password": auth_user["password"]},
            )
            assert r.status_code == 200
        with sync_engine.begin() as c:
            row = c.execute(
                text("select deleted_at from public.users where id = cast(:i as uuid)"),
                {"i": auth_user["user_id"]},
            ).first()
            assert row is not None and row.deleted_at is None

    def test_restore_after_window_410(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "update public.users set deleted_at = now() - interval '31 days' "
                    "where id = cast(:i as uuid)"
                ),
                {"i": auth_user["user_id"]},
            )
        with TestClient(app) as client:
            r = client.post(
                "/auth/account/restore",
                json={"email": auth_user["email"], "password": auth_user["password"]},
            )
            assert r.status_code == 410

    def test_restore_no_pending_deletion_404(self, app: FastAPI, auth_user: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/auth/account/restore",
                json={"email": auth_user["email"], "password": auth_user["password"]},
            )
            assert r.status_code == 404


class TestSignOut:
    """GAP-209: **出る口**。アプリ本体にサインアウトの導線が無かった。

    cookie を捨てるだけでは、盗まれた refresh token は生き続ける。
    サーバー側でも失効させることを固定する。
    """

    def test_signout_revokes_refresh_tokens(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        """サインアウト後は **その人の refresh token が通らない**。"""
        plain, _ = _seed_audit_token(
            sync_engine,
            action="auth.refresh.issued",
            email=auth_user["email"],
            extra={"user_id": auth_user["user_id"], "origin": "test"},
            ttl_seconds=86400,
        )
        access = _make_jwt(auth_user["user_id"])
        with TestClient(app) as client:
            out = client.post("/auth/signout", headers={"Authorization": f"Bearer {access}"})
            assert out.status_code == 204, out.text

            # **サインアウト後は refresh が通らない** (盗まれても使えない)
            after = client.post("/auth/refresh", json={"refresh_token": plain})
            assert after.status_code == 401, after.text

        with sync_engine.connect() as c:
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs"
                    " where action = 'auth.refresh.revoked_all'"
                    "   and target_id::text = :u and (after->>'reason') = 'sign_out'"
                ),
                {"u": auth_user["user_id"]},
            ).scalar_one()
        assert n == 1, "サインアウトの監査記録が無い"

    def test_refresh_still_works_without_signout(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        auth_user: dict[str, str],
    ) -> None:
        """土台の確認 — サインアウトしていなければ refresh は通る。"""
        plain, _ = _seed_audit_token(
            sync_engine,
            action="auth.refresh.issued",
            email=auth_user["email"],
            extra={"user_id": auth_user["user_id"], "origin": "test"},
            ttl_seconds=86400,
        )
        with TestClient(app) as client:
            r = client.post("/auth/refresh", json={"refresh_token": plain})
            assert r.status_code == 200, r.text

    def test_signout_requires_auth(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.post("/auth/signout").status_code == 401


@pytest.mark.integration
class TestStepUpUsesSigninEquivalentPath:
    """GAP-239 回帰: 退会/復元の step-up 再認証が signin と同一経路であること。

    以前は _verify_password_local (sha256 スタブ) を無条件に使っており、
    本番 (bcrypt は Supabase 側が持つ) では正しいパスワードでも必ず 401
    = 誰も退会できなかった。Supabase 検証が成功を返す状況を再現し、
    ローカル stub のハッシュが一致しなくても受け付けることを検証する
    (スタブ専用経路が残っていればこのテストは 401 で落ちる)。
    """

    def test_delete_accepts_supabase_verified_password(
        self,
        app: FastAPI,
        monkeypatch: pytest.MonkeyPatch,
        auth_user: dict[str, str],
    ) -> None:
        from src.services import auth as auth_svc

        async def _fake_supabase_ok(*, email: str, password: str) -> str:
            return auth_user["user_id"]

        monkeypatch.setattr(auth_svc, "_verify_password_supabase", _fake_supabase_ok)
        h = {"Authorization": f"Bearer {_make_jwt(auth_user['user_id'])}"}
        with TestClient(app) as client:
            # ローカル stub の sha256 とは一致しない password でも、
            # Supabase 側が本人と言えば受け付ける (本番経路の再現)
            r = client.post(
                "/auth/account/delete",
                headers=h,
                json={"password": "supabase-only-Password-1!"},
            )
            assert r.status_code == 200, r.text

    def test_restore_accepts_supabase_verified_password(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
        auth_user: dict[str, str],
    ) -> None:
        from src.services import auth as auth_svc

        async def _fake_supabase_ok(*, email: str, password: str) -> str:
            return auth_user["user_id"]

        monkeypatch.setattr(auth_svc, "_verify_password_supabase", _fake_supabase_ok)
        with sync_engine.begin() as c:
            c.execute(
                text("update public.users set deleted_at = now() where id = cast(:i as uuid)"),
                {"i": auth_user["user_id"]},
            )
        with TestClient(app) as client:
            r = client.post(
                "/auth/account/restore",
                json={"email": auth_user["email"], "password": "supabase-only-Password-1!"},
            )
            assert r.status_code == 200, r.text
        with sync_engine.begin() as c:
            row = c.execute(
                text("select deleted_at from public.users where id = cast(:i as uuid)"),
                {"i": auth_user["user_id"]},
            ).first()
            assert row is not None and row.deleted_at is None
