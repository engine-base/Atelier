"""Integration tests for /billing (GAP-021 — S-A03 プランタブ) — 実 Postgres + RLS + JWT。

対象:
  - GET  /billing/plan            … 行なし = free の誠実返却 / stripe_configured / 非メンバー 404
  - POST /billing/checkout        … Checkout Session 実作成 (httpx MockTransport) / 未設定 503 / audit
  - GET  /billing/checkout/{id}   … paid 反映 (ポーリング) / unpaid 誠実表示 / 非メンバー 404
  - POST /billing/webhook         … Stripe-Signature (HMAC v1) 検証 (正 / 不正 / 期限) + プラン更新
  - 実 Stripe テスト API との統合 (STRIPE_SECRET_KEY=sk_test_ の時のみ)

実 DB が無い環境では skip。
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
from collections.abc import AsyncGenerator, Callable, Iterator
from typing import Annotated, Any

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)
# webhook / checkout 照会の書き込みは service session (RLS bypass) を使うため、
# service 側 engine もテスト PG に向ける (admin ops テストと同型)。
os.environ.setdefault("ATELIER_DB_URL", PG_ASYNC)

import httpx  # noqa: E402
import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

import src.services.billing as billing  # noqa: E402
from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402
from src.services.billing import (  # noqa: E402
    STRIPE_API_BASE,
    BillingSettings,
    _session_factory_for_loop,  # pyright: ignore[reportPrivateUsage]  # lru_cache 実体を clear
    verify_webhook_signature,
)

WEBHOOK_SECRET = "whsec_test_secret"


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


def _sign_webhook(payload: bytes, *, secret: str = WEBHOOK_SECRET, ts: int | None = None) -> str:
    """Stripe-Signature ヘッダ (t=...,v1=...) を生成する。"""
    t = int(time.time()) if ts is None else ts
    mac = hmac.new(secret.encode(), f"{t}.".encode() + payload, hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


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

# 実 Stripe テスト API との統合 gate。apps/api/.env の STRIPE_SECRET_KEY が
# sk_test_ で始まる時のみ実走する (本物のテストモード session を実作成)。
_REAL_SETTINGS = BillingSettings()
stripe_live = pytest.mark.skipif(
    not _REAL_SETTINGS.stripe_secret_key.startswith("sk_test_"),
    reason="Stripe test key not configured",
)


def _configured_settings(**overrides: object) -> BillingSettings:
    """環境 (.env) に依存しない決定論的な設定。"""
    values: dict[str, Any] = {
        "stripe_secret_key": "sk_test_dummy_key",
        "stripe_webhook_secret": WEBHOOK_SECRET,
        "atelier_public_base_url": "http://web.test",
    }
    values.update(overrides)
    return BillingSettings(**values)


@pytest.fixture()
def app() -> Iterator[FastAPI]:
    _session_factory_for_loop.cache_clear()
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
    _session_factory_for_loop.cache_clear()


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded_users(sync_engine: sqlalchemy.Engine) -> Iterator[tuple[str, str]]:
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"gap021-{uid[:8]}@t.invalid"
            c.execute(
                text("insert into auth.users (id, email) values (:i,:e)"), {"i": uid, "e": em}
            )
            c.execute(
                text("insert into public.users (id, email) values (:i,:e)"), {"i": uid, "e": em}
            )
    yield u_a, u_b
    with sync_engine.begin() as c:
        # workspace_billing は workspaces ON DELETE CASCADE で同時に消える
        c.execute(
            text("delete from public.workspaces where owner_user_id in (:a,:b)"),
            {"a": u_a, "b": u_b},
        )
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _headers(user_id: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(user_id)}"}


def _create_workspace(client: TestClient, user_id: str, name: str = "GAP021 WS") -> str:
    r = client.post("/workspaces", json={"name": name}, headers=_headers(user_id))
    assert r.status_code == 201, r.text
    return str(r.json()["data"]["id"])


def _mock_stripe(
    monkeypatch: pytest.MonkeyPatch, handler: Callable[[httpx.Request], httpx.Response]
) -> list[httpx.Request]:
    """billing の Stripe HTTP を MockTransport に差し替え、実リクエストを記録する。"""
    seen: list[httpx.Request] = []

    def _wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    def _fake_client(settings: BillingSettings) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=STRIPE_API_BASE,
            transport=httpx.MockTransport(_wrapped),
            headers={"Authorization": f"Bearer {settings.stripe_secret_key}"},
        )

    monkeypatch.setattr(billing, "_http_client", _fake_client)
    return seen


@pytest.mark.unit
class TestWebhookSignature:
    """verify_webhook_signature の単体検証 (DB 不要)。"""

    def test_valid(self) -> None:
        payload = b'{"type":"x"}'
        header = _sign_webhook(payload)
        assert verify_webhook_signature(payload, header, WEBHOOK_SECRET) is True

    def test_wrong_secret(self) -> None:
        payload = b'{"type":"x"}'
        header = _sign_webhook(payload, secret="whsec_other")
        assert verify_webhook_signature(payload, header, WEBHOOK_SECRET) is False

    def test_tampered_payload(self) -> None:
        header = _sign_webhook(b'{"type":"x"}')
        assert verify_webhook_signature(b'{"type":"y"}', header, WEBHOOK_SECRET) is False

    def test_expired_timestamp(self) -> None:
        payload = b'{"type":"x"}'
        ts = int(time.time()) - 301
        header = _sign_webhook(payload, ts=ts)
        assert verify_webhook_signature(payload, header, WEBHOOK_SECRET) is False

    def test_future_timestamp_within_tolerance(self) -> None:
        payload = b'{"type":"x"}'
        header = _sign_webhook(payload, ts=int(time.time()) + 200)
        assert verify_webhook_signature(payload, header, WEBHOOK_SECRET) is True

    def test_missing_or_malformed_header(self) -> None:
        payload = b'{"type":"x"}'
        assert verify_webhook_signature(payload, None, WEBHOOK_SECRET) is False
        assert verify_webhook_signature(payload, "", WEBHOOK_SECRET) is False
        assert verify_webhook_signature(payload, "v1=deadbeef", WEBHOOK_SECRET) is False
        assert verify_webhook_signature(payload, "t=abc,v1=deadbeef", WEBHOOK_SECRET) is False
        assert verify_webhook_signature(payload, f"t={int(time.time())}", WEBHOOK_SECRET) is False


@pytest.mark.integration
class TestBillingPlan:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get(f"/billing/plan?workspace_id={uuid.uuid4()}").status_code == 401

    def test_plan_defaults_to_free_honestly(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """workspace_billing 行なし = free / status inactive を誠実に返す。"""
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            r = client.get(f"/billing/plan?workspace_id={wid}", headers=_headers(u_a))
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            assert data["plan"] == "free"
            assert data["status"] == "inactive"
            assert data["current_period_end"] is None
            assert data["stripe_configured"] is True

    def test_plan_reports_stripe_not_configured(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """未設定環境では stripe_configured=false (フロントはボタンを出さない)。"""
        u_a, _ = seeded_users
        monkeypatch.setattr(
            billing, "get_settings", lambda: _configured_settings(stripe_secret_key="")
        )
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            r = client.get(f"/billing/plan?workspace_id={wid}", headers=_headers(u_a))
            assert r.status_code == 200
            assert r.json()["data"]["stripe_configured"] is False

    def test_plan_non_member_404(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """R-T08: 非メンバーには workspace の存在ごと 404。"""
        u_a, u_b = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            assert (
                client.get(f"/billing/plan?workspace_id={wid}", headers=_headers(u_b)).status_code
                == 404
            )

    def test_plan_bad_workspace_id_404(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            r = client.get("/billing/plan?workspace_id=not-a-uuid", headers=_headers(u_a))
            assert r.status_code == 404


@pytest.mark.integration
class TestBillingCheckout:
    def test_checkout_creates_session_and_audit(
        self,
        app: FastAPI,
        seeded_users: tuple[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "POST"
            assert request.url.path == "/v1/checkout/sessions"
            return httpx.Response(
                200,
                json={
                    "id": "cs_test_123",
                    "url": "https://checkout.stripe.com/c/pay/cs_test_123",
                    "payment_status": "unpaid",
                },
            )

        seen = _mock_stripe(monkeypatch, handler)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            r = client.post("/billing/checkout", json={"workspace_id": wid}, headers=_headers(u_a))
            assert r.status_code == 201, r.text
            data = r.json()["data"]
            assert data["session_id"] == "cs_test_123"
            assert data["url"].startswith("https://checkout.stripe.com/")

            # Stripe へ送った form の中身 (mode=subscription / JPY 月額 / metadata)
            form = seen[0].content.decode()
            assert "mode=subscription" in form
            assert "currency%5D=jpy" in form or "currency]=jpy" in form
            assert "5000" in form
            assert wid in form
            # GAP-115: 登録済みメールが Stripe 決済画面に自動入力される
            assert f"customer_email=gap021-{u_a[:8]}%40t.invalid" in form
            assert seen[0].headers["Authorization"] == "Bearer sk_test_dummy_key"

            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='billing.checkout.create' and target_id=:t"
                    ),
                    {"t": wid},
                ).scalar_one()
            assert n == 1

    def test_checkout_stripe_not_configured_503(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(
            billing, "get_settings", lambda: _configured_settings(stripe_secret_key="")
        )
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            r = client.post("/billing/checkout", json={"workspace_id": wid}, headers=_headers(u_a))
            assert r.status_code == 503

    def test_checkout_non_member_404(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, u_b = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            r = client.post("/billing/checkout", json={"workspace_id": wid}, headers=_headers(u_b))
            assert r.status_code == 404

    def test_checkout_stripe_error_502(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        _mock_stripe(
            monkeypatch,
            lambda _req: httpx.Response(402, json={"error": {"message": "card error"}}),
        )
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            r = client.post("/billing/checkout", json={"workspace_id": wid}, headers=_headers(u_a))
            assert r.status_code == 502


@pytest.mark.integration
class TestCheckoutPoll:
    def _checkout_json(self, wid: str, *, paid: bool) -> dict[str, Any]:
        return {
            "id": "cs_test_poll",
            "payment_status": "paid" if paid else "unpaid",
            "status": "complete" if paid else "open",
            "customer": "cus_test_1",
            "subscription": "sub_test_1",
            "metadata": {"workspace_id": wid},
            "client_reference_id": wid,
        }

    def test_poll_paid_promotes_to_pro(
        self,
        app: FastAPI,
        seeded_users: tuple[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """paid の照会で workspace_billing / workspaces.plan が pro になり audit が残る。"""
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            _mock_stripe(
                monkeypatch,
                lambda _req: httpx.Response(200, json=self._checkout_json(wid, paid=True)),
            )
            r = client.get("/billing/checkout/cs_test_poll", headers=_headers(u_a))
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            assert data["payment_status"] == "paid"
            assert data["plan"] == "pro"
            assert data["workspace_id"] == wid

            with sync_engine.connect() as c:
                row = c.execute(
                    text(
                        "select plan, status, stripe_subscription_id "
                        "from public.workspace_billing where workspace_id=:w"
                    ),
                    {"w": wid},
                ).one()
                assert (row.plan, row.status, row.stripe_subscription_id) == (
                    "pro",
                    "active",
                    "sub_test_1",
                )
                ws_plan = c.execute(
                    text("select plan from public.workspaces where id=:w"), {"w": wid}
                ).scalar_one()
                assert ws_plan == "pro"
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='billing.plan.change' and target_id=:t"
                    ),
                    {"t": wid},
                ).scalar_one()
            assert n == 1

            # 再照会 (ポーリング) しても audit は増えない (冪等)
            r2 = client.get("/billing/checkout/cs_test_poll", headers=_headers(u_a))
            assert r2.status_code == 200
            with sync_engine.connect() as c:
                n2 = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='billing.plan.change' and target_id=:t"
                    ),
                    {"t": wid},
                ).scalar_one()
            assert n2 == 1

    def test_poll_unpaid_reports_honestly(
        self,
        app: FastAPI,
        seeded_users: tuple[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """未決済 session の照会で pro に「しない」(偽の課金成功を出さない)。"""
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            _mock_stripe(
                monkeypatch,
                lambda _req: httpx.Response(200, json=self._checkout_json(wid, paid=False)),
            )
            r = client.get("/billing/checkout/cs_test_poll", headers=_headers(u_a))
            assert r.status_code == 200
            data = r.json()["data"]
            assert data["payment_status"] == "unpaid"
            assert data["plan"] == "free"
            with sync_engine.connect() as c:
                n = c.execute(
                    text("select count(*) from public.workspace_billing where workspace_id=:w"),
                    {"w": wid},
                ).scalar_one()
            assert n == 0

    def test_poll_non_member_404(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, u_b = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            _mock_stripe(
                monkeypatch,
                lambda _req: httpx.Response(200, json=self._checkout_json(wid, paid=True)),
            )
            assert (
                client.get("/billing/checkout/cs_test_poll", headers=_headers(u_b)).status_code
                == 404
            )

    def test_poll_unknown_session_404(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        _mock_stripe(monkeypatch, lambda _req: httpx.Response(404, json={"error": {}}))
        with TestClient(app) as client:
            _create_workspace(client, u_a)
            assert (
                client.get("/billing/checkout/cs_missing", headers=_headers(u_a)).status_code == 404
            )

    def test_poll_not_configured_503(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(
            billing, "get_settings", lambda: _configured_settings(stripe_secret_key="")
        )
        with TestClient(app) as client:
            assert client.get("/billing/checkout/cs_x", headers=_headers(u_a)).status_code == 503


@pytest.mark.integration
class TestBillingWebhook:
    def _post_webhook(
        self, client: TestClient, event: dict[str, Any], *, header: str | None = "auto"
    ) -> Any:
        payload = json.dumps(event).encode()
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if header == "auto":
            headers["Stripe-Signature"] = _sign_webhook(payload)
        elif header is not None:
            headers["Stripe-Signature"] = header
        return client.post("/billing/webhook", content=payload, headers=headers)

    def _completed_event(self, wid: str) -> dict[str, Any]:
        return {
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_test_wh",
                    "payment_status": "paid",
                    "customer": "cus_wh_1",
                    "subscription": "sub_wh_1",
                    "metadata": {"workspace_id": wid},
                }
            },
        }

    def test_webhook_completed_promotes_to_pro(
        self,
        app: FastAPI,
        seeded_users: tuple[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            r = self._post_webhook(client, self._completed_event(wid))
            assert r.status_code == 200, r.text
            assert r.json()["workspace_id"] == wid
            with sync_engine.connect() as c:
                row = c.execute(
                    text("select plan, status from public.workspace_billing where workspace_id=:w"),
                    {"w": wid},
                ).one()
                assert (row.plan, row.status) == ("pro", "active")
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='billing.plan.change' and target_id=:t"
                    ),
                    {"t": wid},
                ).scalar_one()
            assert n == 1

    def test_webhook_subscription_updated_sets_period_end(
        self,
        app: FastAPI,
        seeded_users: tuple[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        period_end = int(time.time()) + 30 * 24 * 3600
        event: dict[str, Any] = {
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": "sub_wh_2",
                    "customer": "cus_wh_2",
                    "status": "active",
                    "current_period_end": period_end,
                    "metadata": {"workspace_id": ""},
                }
            },
        }
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            event["data"]["object"]["metadata"]["workspace_id"] = wid
            r = self._post_webhook(client, event)
            assert r.status_code == 200
            with sync_engine.connect() as c:
                row = c.execute(
                    text(
                        "select plan, status, current_period_end "
                        "from public.workspace_billing where workspace_id=:w"
                    ),
                    {"w": wid},
                ).one()
            assert (row.plan, row.status) == ("pro", "active")
            assert row.current_period_end is not None

    def test_webhook_subscription_deleted_downgrades_to_free(
        self,
        app: FastAPI,
        seeded_users: tuple[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            # まず pro にしてから解約イベント
            assert self._post_webhook(client, self._completed_event(wid)).status_code == 200
            deleted_event: dict[str, Any] = {
                "type": "customer.subscription.deleted",
                "data": {
                    "object": {
                        "id": "sub_wh_1",
                        "customer": "cus_wh_1",
                        "status": "canceled",
                        "metadata": {"workspace_id": wid},
                    }
                },
            }
            assert self._post_webhook(client, deleted_event).status_code == 200
            with sync_engine.connect() as c:
                row = c.execute(
                    text("select plan, status from public.workspace_billing where workspace_id=:w"),
                    {"w": wid},
                ).one()
                ws_plan = c.execute(
                    text("select plan from public.workspaces where id=:w"), {"w": wid}
                ).scalar_one()
            assert (row.plan, row.status) == ("free", "canceled")
            assert ws_plan == "free"

    def test_webhook_invalid_signature_400(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            event = self._completed_event(wid)
            payload = json.dumps(event).encode()
            bad = _sign_webhook(payload, secret="whsec_wrong")
            assert self._post_webhook(client, event, header=bad).status_code == 400
            assert self._post_webhook(client, event, header=None).status_code == 400

    def test_webhook_expired_timestamp_400(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            event = self._completed_event(wid)
            payload = json.dumps(event).encode()
            stale = _sign_webhook(payload, ts=int(time.time()) - 400)
            assert self._post_webhook(client, event, header=stale).status_code == 400

    def test_webhook_secret_not_configured_503(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(
            billing, "get_settings", lambda: _configured_settings(stripe_webhook_secret="")
        )
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a)
            assert self._post_webhook(client, self._completed_event(wid)).status_code == 503

    def test_webhook_unknown_event_ignored(
        self, app: FastAPI, seeded_users: tuple[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", _configured_settings)
        with TestClient(app) as client:
            _create_workspace(client, u_a)
            r = self._post_webhook(client, {"type": "invoice.finalized", "data": {"object": {}}})
            assert r.status_code == 200
            assert r.json() == {"received": True, "workspace_id": None}


@stripe_live
@pytest.mark.integration
@pytest.mark.slow
class TestStripeLiveIntegration:
    """実 Stripe テスト API との統合 (STRIPE_SECRET_KEY=sk_test_ の時のみ実走)。"""

    def test_checkout_session_roundtrip_against_real_stripe(
        self,
        app: FastAPI,
        seeded_users: tuple[str, str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        u_a, _ = seeded_users
        monkeypatch.setattr(billing, "get_settings", lambda: _REAL_SETTINGS)
        with TestClient(app) as client:
            wid = _create_workspace(client, u_a, name="GAP021 Live")
            r = client.post("/billing/checkout", json={"workspace_id": wid}, headers=_headers(u_a))
            assert r.status_code == 201, r.text
            data = r.json()["data"]
            assert data["session_id"].startswith("cs_")
            assert data["url"].startswith("https://checkout.stripe.com/")

            # 実照会: 未決済なので unpaid / free のまま (偽の成功を出さない)
            r2 = client.get(f"/billing/checkout/{data['session_id']}", headers=_headers(u_a))
            assert r2.status_code == 200, r2.text
            status_data = r2.json()["data"]
            assert status_data["payment_status"] == "unpaid"
            assert status_data["plan"] == "free"
            assert status_data["workspace_id"] == wid
