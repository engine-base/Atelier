"""Integration tests for /client/auth/signin + /client/projects/{id} (T-A-35 / R-T08)。

R-T08 致命級: client_portal JWT は project_id claim に限定され、別 project /
別クライアントへのアクセスは 403。**越境試験 PASS 必須**。
"""

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
os.environ.setdefault("ATELIER_DB_URL", PG_ASYNC)

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
    pytest.mark.filterwarnings("ignore::ResourceWarning"),
    pytest.mark.filterwarnings("ignore::pytest.PytestUnraisableExceptionWarning"),
]


@pytest.fixture()
def app() -> Iterator[FastAPI]:
    from src.services.client_signin import _service_session_factory

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
def two_projects(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """2 つの workspace/project + 各 project に client_invitation を seed。

    R-T08 越境試験用: project A 向け招待で発行した client JWT は project B を
    閲覧できないことを検証する。
    """
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a, proj_b = str(uuid.uuid4()), str(uuid.uuid4())
    inv_a, inv_b = str(uuid.uuid4()), str(uuid.uuid4())
    inv_expired = str(uuid.uuid4())
    inv_revoked = str(uuid.uuid4())
    token_a = "client-token-aaaaaaaaaaaa"
    token_b = "client-token-bbbbbbbbbbbb"
    token_expired = "client-token-expired-xxxx"
    token_revoked = "client-token-revoked-yyyy"

    def h(t: str) -> str:
        return hashlib.sha256(t.encode()).hexdigest()

    with sync_engine.begin() as c:
        for u in (u_a, u_b):
            em = f"ta35-{u[:8]}@example.com"
            c.execute(
                text("insert into auth.users(id,email) values(cast(:i as uuid),:e)"),
                {"i": u, "e": em},
            )
            c.execute(
                text("insert into public.users(id,email) values(cast(:i as uuid),:e)"),
                {"i": u, "e": em},
            )
        for ws, o in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text(
                    "insert into public.workspaces(id,owner_user_id,name) values(cast(:i as uuid),cast(:o as uuid),:n)"
                ),
                {"i": ws, "o": o, "n": "w" + ws[:5]},
            )
        for pid, ws, nm in ((proj_a, ws_a, "Project A"), (proj_b, ws_b, "Project B")):
            c.execute(
                text(
                    "insert into public.projects(id,workspace_id,name,project_type) "
                    "values(cast(:i as uuid),cast(:w as uuid),:n,'client_work')"
                ),
                {"i": pid, "w": ws, "n": nm},
            )
        # 有効招待 A / B
        for inv, pid, tok in (
            (inv_a, proj_a, token_a),
            (inv_b, proj_b, token_b),
        ):
            c.execute(
                text(
                    "insert into public.client_invitations"
                    "(id,project_id,email,token_hash,scopes,expires_at) "
                    "values(cast(:i as uuid),cast(:p as uuid),:e,:h,"
                    "'[\"view\",\"comment\"]'::jsonb, now() + interval '7 days')"
                ),
                {"i": inv, "p": pid, "e": f"client-{inv[:6]}@ext.com", "h": h(tok)},
            )
        # 期限切れ招待 (proj_a): created_at も過去にして expiry 制約
        # (expires_at > created_at and <= created_at + 30d) を満たしつつ失効
        c.execute(
            text(
                "insert into public.client_invitations"
                "(id,project_id,email,token_hash,scopes,created_at,expires_at) "
                "values(cast(:i as uuid),cast(:p as uuid),:e,:h,"
                "'[\"view\"]'::jsonb, now() - interval '10 days', now() - interval '1 day')"
            ),
            {"i": inv_expired, "p": proj_a, "e": "exp@ext.com", "h": h(token_expired)},
        )
        # revoked 招待 (proj_a)
        c.execute(
            text(
                "insert into public.client_invitations"
                "(id,project_id,email,token_hash,scopes,expires_at,revoked_at) "
                "values(cast(:i as uuid),cast(:p as uuid),:e,:h,"
                "'[\"view\"]'::jsonb, now() + interval '7 days', now())"
            ),
            {"i": inv_revoked, "p": proj_a, "e": "rev@ext.com", "h": h(token_revoked)},
        )
    yield {
        "proj_a": proj_a,
        "proj_b": proj_b,
        "token_a": token_a,
        "token_b": token_b,
        "token_expired": token_expired,
        "token_revoked": token_revoked,
        "ws_a": ws_a,
        "ws_b": ws_b,
        "u_a": u_a,
        "u_b": u_b,
    }
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.client_invitations where project_id in (cast(:a as uuid),cast(:b as uuid))"
            ),
            {"a": proj_a, "b": proj_b},
        )
        c.execute(
            text("delete from public.workspaces where id in (cast(:a as uuid),cast(:b as uuid))"),
            {"a": ws_a, "b": ws_b},
        )
        c.execute(
            text("delete from public.users where id in (cast(:a as uuid),cast(:b as uuid))"),
            {"a": u_a, "b": u_b},
        )
        c.execute(
            text("delete from auth.users where id in (cast(:a as uuid),cast(:b as uuid))"),
            {"a": u_a, "b": u_b},
        )


@pytest.mark.integration
class TestClientSignin:
    def test_signin_invalid_token_401(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin", json={"invitation_token": "nonexistent-token-zzzz"}
            )
            assert r.status_code == 401

    def test_signin_revoked_401(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_revoked"]},
            )
            assert r.status_code == 401

    def test_signin_expired_410(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_expired"]},
            )
            assert r.status_code == 410

    def test_signin_success_returns_scoped_token(
        self, app: FastAPI, two_projects: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], "display_name": "Client A"},
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["token_type"] == "bearer"
            assert d["project"]["id"] == two_projects["proj_a"]
            assert d["project"]["name"] == "Project A"
            assert "view" in d["scopes"]
            assert len(d["client_access_token"].split(".")) == 3

    def test_project_view_own_project_ok(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        with TestClient(app) as client:
            tok = client.post(
                "/client/auth/signin", json={"invitation_token": two_projects["token_a"]}
            ).json()["data"]["client_access_token"]
            r = client.get(
                f"/client/projects/{two_projects['proj_a']}",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["id"] == two_projects["proj_a"]
            assert r.json()["data"]["name"] == "Project A"

    def test_project_view_cross_project_403_RT08(
        self, app: FastAPI, two_projects: dict[str, str]
    ) -> None:
        """★ R-T08 越境試験 ★: project A の client JWT で project B を見ようとすると 403。"""
        with TestClient(app) as client:
            tok_a = client.post(
                "/client/auth/signin", json={"invitation_token": two_projects["token_a"]}
            ).json()["data"]["client_access_token"]
            r = client.get(
                f"/client/projects/{two_projects['proj_b']}",
                headers={"Authorization": f"Bearer {tok_a}"},
            )
            assert r.status_code == 403, "R-T08 越境拒否が機能していない"

    def test_project_view_unauthenticated_401(
        self, app: FastAPI, two_projects: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            r = client.get(f"/client/projects/{two_projects['proj_a']}")
            assert r.status_code == 401

    def test_project_view_garbage_token_401(
        self, app: FastAPI, two_projects: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            r = client.get(
                f"/client/projects/{two_projects['proj_a']}",
                headers={"Authorization": "Bearer not.a.jwt"},
            )
            assert r.status_code == 401

    def test_regular_jwt_rejected_on_client_endpoint(
        self, app: FastAPI, two_projects: dict[str, str]
    ) -> None:
        """通常 authenticated JWT (role!=client_portal) は client endpoint で 401。"""
        import base64 as _b64
        import hmac as _hmac
        import json as _json
        import time as _time

        secret = os.environ["ATELIER_AUTH_JWT_SECRET"]

        def _seg(d: dict) -> str:
            return _b64.urlsafe_b64encode(_json.dumps(d).encode()).rstrip(b"=").decode()

        header = _seg({"alg": "HS256", "typ": "JWT"})
        payload = _seg(
            {"sub": two_projects["u_a"], "role": "authenticated", "exp": int(_time.time()) + 3600}
        )
        sig = (
            _b64.urlsafe_b64encode(
                _hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
            )
            .rstrip(b"=")
            .decode()
        )
        regular = f"{header}.{payload}.{sig}"
        with TestClient(app) as client:
            r = client.get(
                f"/client/projects/{two_projects['proj_a']}",
                headers={"Authorization": f"Bearer {regular}"},
            )
            # role != client_portal → decode_client_token が 401
            assert r.status_code == 401

    def test_signin_used_at_recorded(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, two_projects: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], "display_name": "Used Client"},
            )
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select used_at, client_display_name from public.client_invitations "
                    "where project_id = cast(:p as uuid) and used_at is not null"
                ),
                {"p": two_projects["proj_a"]},
            ).first()
            assert row is not None
            assert row.client_display_name == "Used Client"
        # audit client.signin
        with sync_engine.begin() as c:
            cnt = c.execute(
                text("select count(*) from public.audit_logs where action = 'client.signin'")
            ).scalar_one()
            assert cnt >= 1
