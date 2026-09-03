"""Integration tests for /client/auth/signin + /client/projects/{id} (T-A-35 / R-T08)。

R-T08 致命級: client_portal JWT は project_id claim に限定され、別 project /
別クライアントへのアクセスは 403。**越境試験 PASS 必須**。
"""

from __future__ import annotations

import hashlib
import json
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

_CONSENT = {"agree_legal": True, "agree_confidential": True}
"""GAP-028: signin はサーバー側で同意 2 種必須 (欠落は 422)。"""


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
        # GAP-227: 失効を「あとから」起こすテストのため、招待の id も渡す
        "inv_a": inv_a,
        "inv_b": inv_b,
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
                "/client/auth/signin",
                json={"invitation_token": "nonexistent-token-zzzz", **_CONSENT},
            )
            assert r.status_code == 401

    def test_signin_revoked_401(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_revoked"], **_CONSENT},
            )
            assert r.status_code == 401

    def test_signin_expired_410(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_expired"], **_CONSENT},
            )
            assert r.status_code == 410

    def test_signin_success_returns_scoped_token(
        self, app: FastAPI, two_projects: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={
                    "invitation_token": two_projects["token_a"],
                    "display_name": "Client A",
                    **_CONSENT,
                },
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
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], **_CONSENT},
            ).json()["data"]["client_access_token"]
            r = client.get(
                f"/client/projects/{two_projects['proj_a']}",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            assert r.json()["data"]["id"] == two_projects["proj_a"]
            assert r.json()["data"]["name"] == "Project A"

    def test_失効させたら配布済みの券もその場で止まる(
        self, app: FastAPI, two_projects: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """GAP-227 — 2026-08-26 の通し J24-02 で見つけた穴 (R-T08 隣接)。

        券の検証は署名と有効期限しか見ていなかったので、招待を失効させても
        **配布済みの券は TTL (24h) のあいだ通り続けた**。取引が終わって窓口を
        閉じたつもりでも、相手は丸 1 日、進捗も成果物もモックも読めた。

        「失効させる」は **次のアクセスから効く**のでなければ意味が無い。
        """
        with TestClient(app) as client:
            tok = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], **_CONSENT},
            ).json()["data"]["client_access_token"]
            h = {"Authorization": f"Bearer {tok}"}
            # 失効前は読める (= 拒否が「全部ダメ」ではないことを先に示す)
            assert (
                client.get(f"/client/projects/{two_projects['proj_a']}", headers=h).status_code
                == 200
            )

            with sync_engine.begin() as c:
                c.execute(
                    text(
                        "update public.client_invitations set revoked_at = now() "
                        "where id = cast(:i as uuid)"
                    ),
                    {"i": two_projects["inv_a"]},
                )

            # 同じ券で、同じ口を叩く
            for path in (
                f"/client/projects/{two_projects['proj_a']}",
                f"/client/projects/{two_projects['proj_a']}/overview",
                f"/client/projects/{two_projects['proj_a']}/outputs",
                f"/client/projects/{two_projects['proj_a']}/mocks",
                f"/client/projects/{two_projects['proj_a']}/comments",
            ):
                r = client.get(path, headers=h)
                assert r.status_code == 401, f"{path} が失効後も通っている: {r.status_code}"
                assert "取り消され" in r.json()["detail"], r.text

    def test_案件ごと消えたら券も通らない(
        self, app: FastAPI, two_projects: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """GAP-227: 案件が消えたのに、その案件の券が生き続けない。"""
        with TestClient(app) as client:
            tok = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], **_CONSENT},
            ).json()["data"]["client_access_token"]
            h = {"Authorization": f"Bearer {tok}"}
            with sync_engine.begin() as c:
                c.execute(
                    text(
                        "update public.projects set deleted_at = now() where id = cast(:i as uuid)"
                    ),
                    {"i": two_projects["proj_a"]},
                )
            r = client.get(f"/client/projects/{two_projects['proj_a']}", headers=h)
            assert r.status_code == 401, r.text

    def test_取り消した招待は理由が取り消しで返る_GAP251(
        self, app: FastAPI, two_projects: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """GAP-251: 取り消し済みの招待リンクで preview / signin すると、「リンク誤り・期限切れ」
        ではなく「取り消された」と分かる文言で 401 (利用者は自分では直せない → 誰に言うか)。"""
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "update public.client_invitations set revoked_at = now() "
                    "where id = cast(:i as uuid)"
                ),
                {"i": two_projects["inv_a"]},
            )
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/preview", json={"invitation_token": two_projects["token_a"]}
            )
            assert r.status_code == 401, r.text
            assert "取り消され" in r.json()["detail"], r.text
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], **_CONSENT},
            )
            assert r.status_code == 401, r.text
            assert "取り消され" in r.json()["detail"], r.text

    def test_削除済み案件の招待では_signin_も_preview_も拒否し案件名を返さない_GAP253(
        self, app: FastAPI, two_projects: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """GAP-253: 案件を削除したあと、その案件の招待リンクで signin すると 200 で券が出て
        案件名まで返っていた (preview は 401)。両方 401 にし、本文に案件名を含めない。"""
        with sync_engine.begin() as c:
            c.execute(
                text("update public.projects set deleted_at = now() where id = cast(:i as uuid)"),
                {"i": two_projects["proj_a"]},
            )
        with TestClient(app) as client:
            for path, body in (
                ("/client/auth/preview", {"invitation_token": two_projects["token_a"]}),
                ("/client/auth/signin", {"invitation_token": two_projects["token_a"], **_CONSENT}),
            ):
                r = client.post(path, json=body)
                assert r.status_code == 401, f"{path}: {r.status_code} {r.text}"
                assert "Project A" not in r.text, f"{path} が削除済み案件の名前を返した: {r.text}"
                assert "client_access_token" not in r.text

    def test_project_view_cross_project_403_RT08(
        self, app: FastAPI, two_projects: dict[str, str]
    ) -> None:
        """★ R-T08 越境試験 ★: project A の client JWT で project B を見ようとすると 403。"""
        with TestClient(app) as client:
            tok_a = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], **_CONSENT},
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

        def _seg(d: dict[str, object]) -> str:
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
                json={
                    "invitation_token": two_projects["token_a"],
                    "display_name": "Used Client",
                    **_CONSENT,
                },
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

    def test_signin_increments_use_count(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, two_projects: dict[str, str]
    ) -> None:
        """GAP-027②: サインイン成功ごとに use_count が増分される (2 回 → 2)。"""
        with TestClient(app) as client:
            for _ in range(2):
                r = client.post(
                    "/client/auth/signin",
                    json={"invitation_token": two_projects["token_a"], **_CONSENT},
                )
                assert r.status_code == 200
        token_hash = hashlib.sha256(two_projects["token_a"].encode()).hexdigest()
        with sync_engine.begin() as c:
            cnt = c.execute(
                text("select use_count from public.client_invitations where token_hash = :h"),
                {"h": token_hash},
            ).scalar_one()
            assert cnt == 2

    def test_failed_signin_does_not_increment_use_count(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, two_projects: dict[str, str]
    ) -> None:
        """無効 token のサインイン失敗は use_count を進めない。"""
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": "bogus-token-not-issued", **_CONSENT},
            )
            assert r.status_code == 401
        token_hash = hashlib.sha256(two_projects["token_a"].encode()).hexdigest()
        with sync_engine.begin() as c:
            cnt = c.execute(
                text("select use_count from public.client_invitations where token_hash = :h"),
                {"h": token_hash},
            ).scalar_one()
            assert cnt == 0


@pytest.mark.integration
class TestInvitationPreview:
    """GAP-028: 署名前プレビュー (メタ限定・read-only) + 同意永続。"""

    def test_preview_returns_meta_only(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/preview", json={"invitation_token": two_projects["token_a"]}
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["project_name"] == "Project A"
            assert d["workspace_name"].startswith("w")
            # fixture の owner は display_name 未設定 → null (推測で埋めない)
            assert d["inviter_name"] is None
            assert d["invited_email"].endswith("@ext.com")
            assert 0 < d["remaining_days"] <= 7
            # メタ限定: 内部 ID / scopes / token 類は返さない
            assert "project_id" not in d
            assert "scopes" not in d

    def test_preview_invalid_and_revoked_401(
        self, app: FastAPI, two_projects: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/preview", json={"invitation_token": "nonexistent-token-zzzz"}
            )
            assert r.status_code == 401
            r = client.post(
                "/client/auth/preview",
                json={"invitation_token": two_projects["token_revoked"]},
            )
            assert r.status_code == 401

    def test_preview_expired_410(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/preview",
                json={"invitation_token": two_projects["token_expired"]},
            )
            assert r.status_code == 410

    def test_preview_is_read_only(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, two_projects: dict[str, str]
    ) -> None:
        """プレビューは use_count / used_at / 同意に一切触れない。"""
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/preview", json={"invitation_token": two_projects["token_a"]}
            )
            assert r.status_code == 200
        token_hash = hashlib.sha256(two_projects["token_a"].encode()).hexdigest()
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select use_count, used_at, legal_consented_at, confidential_consented_at "
                    "from public.client_invitations where token_hash = :h"
                ),
                {"h": token_hash},
            ).first()
            assert row is not None
            assert row.use_count == 0
            assert row.used_at is None
            assert row.legal_consented_at is None
            assert row.confidential_consented_at is None

    def test_signin_without_consent_422(self, app: FastAPI, two_projects: dict[str, str]) -> None:
        """GAP-028: 同意 2 種のいずれかが欠けたサインインは 422 (JWT を発行しない)。"""
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin", json={"invitation_token": two_projects["token_a"]}
            )
            assert r.status_code == 422
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], "agree_legal": True},
            )
            assert r.status_code == 422

    def test_signin_persists_first_consent_timestamps(
        self, app: FastAPI, sync_engine: sqlalchemy.Engine, two_projects: dict[str, str]
    ) -> None:
        """初回同意時刻を永続し、再サインインで上書きしない (法務証跡)。"""
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], **_CONSENT},
            )
            assert r.status_code == 200
        token_hash = hashlib.sha256(two_projects["token_a"].encode()).hexdigest()
        with sync_engine.begin() as c:
            first = c.execute(
                text(
                    "select legal_consented_at, confidential_consented_at "
                    "from public.client_invitations where token_hash = :h"
                ),
                {"h": token_hash},
            ).first()
            assert first is not None
            assert first.legal_consented_at is not None
            assert first.confidential_consented_at is not None
        with TestClient(app) as client:
            r = client.post(
                "/client/auth/signin",
                json={"invitation_token": two_projects["token_a"], **_CONSENT},
            )
            assert r.status_code == 200
        with sync_engine.begin() as c:
            second = c.execute(
                text(
                    "select legal_consented_at, confidential_consented_at "
                    "from public.client_invitations where token_hash = :h"
                ),
                {"h": token_hash},
            ).first()
            assert second is not None
            assert second.legal_consented_at == first.legal_consented_at
            assert second.confidential_consented_at == first.confidential_consented_at


@pytest.fixture()
def portal_content(
    sync_engine: sqlalchemy.Engine, two_projects: dict[str, str]
) -> Iterator[dict[str, str]]:
    """GAP-029: proj_a に phases / outputs / mocks + view-only 招待を seed。

    proj_b にも output を 1 件置き、越境 target が 404 になることを検証する。
    """
    proj_a, proj_b = two_projects["proj_a"], two_projects["proj_b"]
    out_hear_v1, out_hear_v2 = str(uuid.uuid4()), str(uuid.uuid4())
    out_req, out_b = str(uuid.uuid4()), str(uuid.uuid4())
    mock_top_v1, mock_top_v2, mock_cart = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    inv_view = str(uuid.uuid4())
    token_view = "client-token-view-zzzzzzzz"
    token_hash = hashlib.sha256(token_view.encode()).hexdigest()
    with sync_engine.begin() as c:
        for order, name, status_v in (
            (1, "ヒアリング", "completed"),
            (2, "要件", "in_progress"),
            (3, "納品", "pending"),
        ):
            c.execute(
                text(
                    'insert into public.phases(project_id,"order",name,status) '
                    "values(cast(:p as uuid),:o,:n,cast(:s as phase_status_enum))"
                ),
                {"p": proj_a, "o": order, "n": name, "s": status_v},
            )
        for oid, pid, stage, ver, html, md in (
            (out_hear_v1, proj_a, "hearing", 1, "h1.html", "h1.md"),
            (out_hear_v2, proj_a, "hearing", 2, "h2.html", None),
            (out_req, proj_a, "requirements", 1, None, "r1.md"),
            (out_b, proj_b, "hearing", 1, "bh.html", None),
        ):
            c.execute(
                text(
                    "insert into public.workflow_outputs"
                    "(id,project_id,stage,version,html_path,md_path,summary) "
                    "values(cast(:i as uuid),cast(:p as uuid),"
                    "cast(:s as workflow_stage_enum),:v,:h,:m,'サマリー')"
                ),
                {"i": oid, "p": pid, "s": stage, "v": ver, "h": html, "m": md},
            )
        for mid, name, ver in (
            (mock_top_v1, "トップページ", 1),
            (mock_top_v2, "トップページ", 2),
            (mock_cart, "カート", 1),
        ):
            c.execute(
                text(
                    "insert into public.mocks(id,project_id,screen_name,html_storage_path,version) "
                    "values(cast(:i as uuid),cast(:p as uuid),:n,:path,:v)"
                ),
                {"i": mid, "p": proj_a, "n": name, "path": f"mocks/{mid}.html", "v": ver},
            )
        c.execute(
            text(
                "insert into public.client_invitations"
                "(id,project_id,email,token_hash,scopes,expires_at) "
                "values(cast(:i as uuid),cast(:p as uuid),:e,:h,"
                "'[\"view\"]'::jsonb, now() + interval '7 days')"
            ),
            {"i": inv_view, "p": proj_a, "e": "viewonly@ext.com", "h": token_hash},
        )
    yield {
        **two_projects,
        "out_hear_v2": out_hear_v2,
        "out_req": out_req,
        "out_b": out_b,
        "mock_top_v2": mock_top_v2,
        "mock_cart": mock_cart,
        "token_view": token_view,
    }
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.comments where target_id in "
                "(select id from public.workflow_outputs where project_id in "
                " (cast(:a as uuid),cast(:b as uuid))) "
                "or target_id in (select id from public.mocks where project_id = cast(:a as uuid))"
            ),
            {"a": proj_a, "b": proj_b},
        )
        c.execute(
            text(
                "delete from public.audit_logs where action in "
                "('client.comment.create','client.comment.staff_notified')"
            ),
        )
        for table in ("workflow_outputs", "mocks", "phases"):
            c.execute(
                text(
                    f"delete from public.{table} where project_id in "
                    "(cast(:a as uuid),cast(:b as uuid))"
                ),
                {"a": proj_a, "b": proj_b},
            )
        c.execute(
            text("delete from public.client_invitations where id = cast(:i as uuid)"),
            {"i": inv_view},
        )


def _client_token(client: TestClient, invitation_token: str) -> str:
    return client.post(
        "/client/auth/signin",
        json={"invitation_token": invitation_token, **_CONSENT},
    ).json()["data"]["client_access_token"]


@pytest.mark.integration
class TestClientPortalContent:
    """GAP-029: S-L03 実コンテンツ read API + コメント投稿 (R-T08 越境試験込)。"""

    def test_overview_real_progress_and_link_expiry(
        self, app: FastAPI, portal_content: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            tok = _client_token(client, portal_content["token_a"])
            r = client.get(
                f"/client/projects/{portal_content['proj_a']}/overview",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert [p["name"] for p in d["phases"]] == ["ヒアリング", "要件", "納品"]
            assert d["progress_percent"] == 33  # completed 1 / 3 の実計算
            assert d["operator_workspace_name"] is not None
            assert d["link_remaining_days"] >= 6  # 招待は +7 days で seed
            assert d["link_expires_at"] is not None

    def test_outputs_latest_per_stage_with_real_formats(
        self, app: FastAPI, portal_content: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            tok = _client_token(client, portal_content["token_a"])
            r = client.get(
                f"/client/projects/{portal_content['proj_a']}/outputs",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            items = {i["stage"]: i for i in r.json()["data"]}
            assert set(items) == {"hearing", "requirements"}
            # stage 毎の最新版のみ + 実在フォーマットのみ
            assert items["hearing"]["version"] == 2
            assert items["hearing"]["formats"] == ["html"]
            assert items["hearing"]["stage_label"] == "ヒアリングサマリー"
            assert items["requirements"]["formats"] == ["md"]
            # 他 project (proj_b) の成果物は混ざらない
            ids = {i["id"] for i in r.json()["data"]}
            assert portal_content["out_b"] not in ids

    def test_mocks_latest_per_screen(self, app: FastAPI, portal_content: dict[str, str]) -> None:
        with TestClient(app) as client:
            tok = _client_token(client, portal_content["token_a"])
            r = client.get(
                f"/client/projects/{portal_content['proj_a']}/mocks",
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["total_screens"] == 2
            by_name = {i["screen_name"]: i for i in d["items"]}
            assert by_name["トップページ"]["version"] == 2  # 最新版のみ
            assert by_name["カート"]["version"] == 1

    def test_comment_post_list_and_staff_reply_visibility(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        portal_content: dict[str, str],
    ) -> None:
        with TestClient(app) as client:
            tok = _client_token(client, portal_content["token_a"])
            h = {"Authorization": f"Bearer {tok}"}
            r = client.post(
                f"/client/projects/{portal_content['proj_a']}/comments",
                json={
                    "target_type": "workflow_output",
                    "target_id": portal_content["out_hear_v2"],
                    "content": "§2 の内訳を確認したいです",
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            posted = r.json()["data"]
            assert posted["is_client_author"] is True
            assert posted["target_label"] == "ヒアリングサマリー"
            with sync_engine.connect() as c:
                row = c.execute(
                    text(
                        "select author_invitation_id, author_user_id from public.comments "
                        "where id = cast(:i as uuid)"
                    ),
                    {"i": posted["id"]},
                ).one()
                assert row.author_invitation_id is not None
                assert row.author_user_id is None
                audit = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action = 'client.comment.create' and target_id = :i"
                    ),
                    {"i": posted["id"]},
                ).scalar()
                assert audit == 1
            # 運営返信 + 無関係コメント (別 author・親無し) を seed
            with sync_engine.begin() as c:
                c.execute(
                    text(
                        "insert into public.comments"
                        "(target_type,target_id,author_user_id,content,parent_comment_id) "
                        "values('workflow_output',cast(:t as uuid),cast(:u as uuid),"
                        "'運営からの返信です',cast(:parent as uuid))"
                    ),
                    {
                        "t": portal_content["out_hear_v2"],
                        "u": portal_content["u_a"],
                        "parent": posted["id"],
                    },
                )
                c.execute(
                    text(
                        "insert into public.comments"
                        "(target_type,target_id,author_user_id,content) "
                        "values('workflow_output',cast(:t as uuid),cast(:u as uuid),'社内メモ')"
                    ),
                    {"t": portal_content["out_hear_v2"], "u": portal_content["u_a"]},
                )
            r2 = client.get(
                f"/client/projects/{portal_content['proj_a']}/comments",
                headers=h,
            )
            assert r2.status_code == 200
            contents = [i["content"] for i in r2.json()["data"]]
            assert "§2 の内訳を確認したいです" in contents
            assert "運営からの返信です" in contents  # 自分のコメントへの返信は見える
            assert "社内メモ" not in contents  # 無関係な社内コメントは見えない

    def test_content_cross_project_403_RT08(
        self, app: FastAPI, portal_content: dict[str, str]
    ) -> None:
        """★ R-T08 越境試験 ★: proj_a の client JWT で proj_b の全コンテンツ endpoint が 403。"""
        with TestClient(app) as client:
            tok = _client_token(client, portal_content["token_a"])
            h = {"Authorization": f"Bearer {tok}"}
            pb = portal_content["proj_b"]
            for path in ("overview", "outputs", "mocks", "comments"):
                r = client.get(f"/client/projects/{pb}/{path}", headers=h)
                assert r.status_code == 403, f"R-T08 越境拒否が機能していない: {path}"
            r = client.post(
                f"/client/projects/{pb}/comments",
                json={
                    "target_type": "workflow_output",
                    "target_id": portal_content["out_b"],
                    "content": "越境",
                },
                headers=h,
            )
            assert r.status_code == 403

    def test_gap266_client_comment_notifies_workspace_owner(
        self,
        app: FastAPI,
        sync_engine: sqlalchemy.Engine,
        portal_content: dict[str, str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """GAP-266 (通し J23-01): クライアントのコメントは運営 (WS 所有者) に届く。

        メールは dry-run (API キー無し) でも送信痕跡 = 監査ログ
        client.comment.staff_notified が、コメントと同じ actor で残る。"""
        monkeypatch.delenv("ATELIER_EMAIL_API_KEY", raising=False)
        with TestClient(app) as client:
            tok = _client_token(client, portal_content["token_a"])
            r = client.post(
                f"/client/projects/{portal_content['proj_a']}/comments",
                json={
                    "target_type": "workflow_output",
                    "target_id": portal_content["out_hear_v2"],
                    "content": "納期の相談をしたいです",
                },
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 201, r.text
            comment_id = r.json()["data"]["id"]
        with sync_engine.begin() as c:
            rows = c.execute(
                text(
                    "select actor_type, actor_id, after from public.audit_logs "
                    "where action = 'client.comment.staff_notified' and target_id = :i"
                ),
                {"i": comment_id},
            ).all()
        assert len(rows) == 1, rows
        after = rows[0].after if isinstance(rows[0].after, dict) else json.loads(rows[0].after)
        assert after["recipient_user_id"] == portal_content["u_a"]  # WS 所有者
        assert after["project_id"] == portal_content["proj_a"]
        assert after["dry_run"] is True
        assert rows[0].actor_type == "anonymous"
        assert rows[0].actor_id == f"client:{portal_content['inv_a']}"

    def test_comment_target_from_other_project_404(
        self, app: FastAPI, portal_content: dict[str, str]
    ) -> None:
        """R-T08: 自 project へ他 project の target を指しても存在ごと秘匿 (404)。"""
        with TestClient(app) as client:
            tok = _client_token(client, portal_content["token_a"])
            r = client.post(
                f"/client/projects/{portal_content['proj_a']}/comments",
                json={
                    "target_type": "workflow_output",
                    "target_id": portal_content["out_b"],
                    "content": "他 project の成果物へ",
                },
                headers={"Authorization": f"Bearer {tok}"},
            )
            assert r.status_code == 404

    def test_comment_requires_comment_scope_403(
        self, app: FastAPI, portal_content: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            tok_view = _client_token(client, portal_content["token_view"])
            h = {"Authorization": f"Bearer {tok_view}"}
            # view スコープでは read は可
            assert (
                client.get(
                    f"/client/projects/{portal_content['proj_a']}/overview", headers=h
                ).status_code
                == 200
            )
            # comment スコープ無しの投稿は 403
            r = client.post(
                f"/client/projects/{portal_content['proj_a']}/comments",
                json={
                    "target_type": "workflow_output",
                    "target_id": portal_content["out_hear_v2"],
                    "content": "view のみで投稿",
                },
                headers=h,
            )
            assert r.status_code == 403

    def test_content_unauthenticated_and_garbage_401(
        self, app: FastAPI, portal_content: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            pa = portal_content["proj_a"]
            assert client.get(f"/client/projects/{pa}/overview").status_code == 401
            assert (
                client.get(
                    f"/client/projects/{pa}/outputs",
                    headers={"Authorization": "Bearer not.a.jwt"},
                ).status_code
                == 401
            )
