"""課金 (Stripe) サービス層 — GAP-021 (S-A03 プランタブ)。

方針 (誠実設計):
  - Stripe は SDK を追加せず httpx で REST を直叩き (secret はサーバーのみで保持)。
  - workspace_billing に行が無い workspace は free (偽の課金状態を作らない)。
  - STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET 未設定の環境では該当 endpoint が
    503 を返し、フロントは「決済連携が未設定」を明示する (偽の成功を出さない)。
  - workspace_billing への書き込みは service session (RLS bypass) のみ。
    authenticated ロールには select policy しか無く、UI からの改ざん経路が無い。

更新経路は 2 つ (webhook 無し環境でも完結する):
  1. GET /billing/checkout/{session_id} — 成功ページからのポーリング照会
  2. POST /billing/webhook — Stripe-Signature (HMAC v1) 検証済みイベント
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import time
import uuid
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any, cast

import httpx
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.audit.writer import ActorType
from src.db.session import create_engine, create_session_factory

STRIPE_API_BASE = "https://api.stripe.com"

# Stripe 公式実装と同じ許容 clock skew (秒)。
WEBHOOK_TOLERANCE_SECONDS = 300

# S-A03 プランタブの定額プラン (JPY 月額 / テストモード)。
PRO_PLAN_NAME = "Atelier Pro"
PRO_PLAN_CURRENCY = "jpy"
PRO_PLAN_UNIT_AMOUNT = 5000

# subscription status → plan の写像。active/trialing のみ pro 扱い。
_PRO_STATUSES = frozenset({"active", "trialing", "past_due"})


class BillingSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    stripe_secret_key: str = Field(default="", description="STRIPE_SECRET_KEY (sk_test_...)")
    stripe_webhook_secret: str = Field(default="", description="STRIPE_WEBHOOK_SECRET (whsec_...)")
    atelier_public_base_url: str = Field(
        default="http://localhost:3000",
        description=(
            "checkout success/cancel の戻り先 web ベース URL "
            "(magic link / 招待リンクと共通の ATELIER_PUBLIC_BASE_URL)"
        ),
    )
    stripe_timeout_seconds: float = Field(default=30.0, gt=0)


@lru_cache(maxsize=1)
def get_settings() -> BillingSettings:
    return BillingSettings()


# --------------------------------------------------------------------------- #
# service session (RLS bypass — workspace_billing の唯一の書き込み経路)
# --------------------------------------------------------------------------- #
@lru_cache(maxsize=8)
def _session_factory_for_loop(loop_key: int) -> async_sessionmaker[AsyncSession]:
    """service_role 相当の sessionmaker (RLS バイパス。event loop 毎に分離キャッシュ)。"""
    del loop_key
    return create_session_factory(create_engine())


def service_session_factory() -> async_sessionmaker[AsyncSession]:
    return _session_factory_for_loop(id(asyncio.get_running_loop()))


service_session_factory.cache_clear = (  # pyright: ignore[reportAttributeAccessIssue, reportFunctionMemberAccess]
    _session_factory_for_loop.cache_clear
)


# --------------------------------------------------------------------------- #
# schemas
# --------------------------------------------------------------------------- #
class BillingPlanResponse(BaseModel):
    workspace_id: str
    plan: str
    """'free' | 'pro' — workspace_billing 行なし = free (誠実既定)。"""
    status: str
    current_period_end: datetime | None
    stripe_configured: bool
    """False の環境ではアップグレード導線を出さない (フロント契約)。"""


class CheckoutCreateRequest(BaseModel):
    workspace_id: str


class CheckoutCreateResponse(BaseModel):
    url: str
    session_id: str


class CheckoutStatusResponse(BaseModel):
    session_id: str
    payment_status: str
    """Stripe checkout session の payment_status ('paid' | 'unpaid' | ...)。"""
    status: str
    """Stripe checkout session の status ('open' | 'complete' | 'expired')。"""
    workspace_id: str
    plan: str
    """照会反映後の現在プラン。paid でなければ既存プランのまま (偽の成功を出さない)。"""


class StripeApiError(Exception):
    """Stripe REST が 2xx 以外を返した (上流エラー)。"""

    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(f"Stripe API error {status_code}: {body[:200]}")
        self.status_code = status_code
        self.body = body


def is_uuid(value: str) -> bool:
    """path/query param の UUID 妥当性 (不正値を 500 ではなく 404 に落とす)。"""
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def as_str_dict(value: object) -> dict[str, Any]:
    """Stripe JSON のネスト (metadata 等) を dict[str, Any] に安全に narrow する。"""
    if isinstance(value, dict):
        return cast("dict[str, Any]", value)
    return {}


# --------------------------------------------------------------------------- #
# Stripe REST (httpx 直叩き)
# --------------------------------------------------------------------------- #
def _http_client(settings: BillingSettings) -> httpx.AsyncClient:
    """Stripe 用 AsyncClient (テストは本関数を monkeypatch して MockTransport を注入)。"""
    return httpx.AsyncClient(
        base_url=STRIPE_API_BASE,
        timeout=settings.stripe_timeout_seconds,
        headers={"Authorization": f"Bearer {settings.stripe_secret_key}"},
    )


async def create_checkout_session(
    settings: BillingSettings, *, workspace_id: str
) -> dict[str, Any]:
    """Stripe Checkout Session (mode=subscription, price_data インライン) を実作成する。"""
    base = settings.atelier_public_base_url.rstrip("/")
    form: dict[str, str] = {
        "mode": "subscription",
        # {CHECKOUT_SESSION_ID} は Stripe 側で実 session id に置換される
        "success_url": f"{base}/workspace-settings?session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url": f"{base}/workspace-settings?checkout=cancel",
        "client_reference_id": workspace_id,
        "metadata[workspace_id]": workspace_id,
        "subscription_data[metadata][workspace_id]": workspace_id,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": PRO_PLAN_CURRENCY,
        "line_items[0][price_data][unit_amount]": str(PRO_PLAN_UNIT_AMOUNT),
        "line_items[0][price_data][recurring][interval]": "month",
        "line_items[0][price_data][product_data][name]": PRO_PLAN_NAME,
    }
    async with _http_client(settings) as client:
        res = await client.post("/v1/checkout/sessions", data=form)
    if res.status_code >= 400:
        raise StripeApiError(res.status_code, res.text)
    return cast("dict[str, Any]", res.json())


async def retrieve_checkout_session(
    settings: BillingSettings, *, session_id: str
) -> dict[str, Any] | None:
    """Checkout Session を Stripe に照会する。404 (不在) は None。"""
    async with _http_client(settings) as client:
        res = await client.get(f"/v1/checkout/sessions/{session_id}")
    if res.status_code == 404:
        return None
    if res.status_code >= 400:
        raise StripeApiError(res.status_code, res.text)
    return cast("dict[str, Any]", res.json())


# --------------------------------------------------------------------------- #
# webhook 署名検証 (Stripe-Signature: t=...,v1=... / HMAC-SHA256)
# --------------------------------------------------------------------------- #
def verify_webhook_signature(
    payload: bytes,
    signature_header: str | None,
    secret: str,
    *,
    now: int | None = None,
    tolerance_seconds: int = WEBHOOK_TOLERANCE_SECONDS,
) -> bool:
    """Stripe v1 scheme の署名を検証する。

    signed_payload = f"{t}.{payload}" の HMAC-SHA256 hex が v1 のいずれかと
    constant-time 一致し、|now - t| <= tolerance であれば True。
    """
    if not signature_header:
        return False
    timestamp: int | None = None
    candidates: list[str] = []
    for part in signature_header.split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            try:
                timestamp = int(value)
            except ValueError:
                return False
        elif key == "v1":
            candidates.append(value)
    if timestamp is None or not candidates:
        return False
    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > tolerance_seconds:
        return False
    signed_payload = f"{timestamp}.".encode() + payload
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, c) for c in candidates)


# --------------------------------------------------------------------------- #
# 読み取り (RLS session — メンバーのみ可視)
# --------------------------------------------------------------------------- #
async def workspace_visible(session: AsyncSession, workspace_id: str) -> bool:
    """RLS 越しに workspace が見えるか (非メンバー = 不可視 → route は 404 / R-T08)。"""
    if not is_uuid(workspace_id):
        return False
    res = await session.execute(
        text("select 1 from public.workspaces where id = :id and deleted_at is null"),
        {"id": workspace_id},
    )
    return res.first() is not None


async def get_plan(
    session: AsyncSession, *, workspace_id: str, stripe_configured: bool
) -> BillingPlanResponse:
    """現在プラン。workspace_billing 行なし = free を誠実に返す。"""
    res = await session.execute(
        text(
            "select plan, status, current_period_end from public.workspace_billing "
            "where workspace_id = :id"
        ),
        {"id": workspace_id},
    )
    row = res.first()
    if row is None:
        return BillingPlanResponse(
            workspace_id=workspace_id,
            plan="free",
            status="inactive",
            current_period_end=None,
            stripe_configured=stripe_configured,
        )
    return BillingPlanResponse(
        workspace_id=workspace_id,
        plan=str(row.plan),
        status=str(row.status),
        current_period_end=row.current_period_end,
        stripe_configured=stripe_configured,
    )


# --------------------------------------------------------------------------- #
# 書き込み (service session — checkout 照会 / webhook のみが呼ぶ)
# --------------------------------------------------------------------------- #
async def apply_billing_update(
    *,
    workspace_id: str,
    plan: str,
    status: str,
    stripe_customer_id: str | None = None,
    stripe_subscription_id: str | None = None,
    current_period_end: datetime | None = None,
    actor_type: ActorType = "system",
    actor_id: str = "stripe",
    source: str,
) -> bool:
    """workspace_billing を upsert し workspaces.plan を同期する。

    plan / status が実際に変化した時のみ audit (billing.plan.change) を記録し
    True を返す (照会ポーリングの重複呼び出しで audit が氾濫しない冪等設計)。
    """
    if not is_uuid(workspace_id):
        return False
    async with service_session_factory()() as session:
        prev = (
            await session.execute(
                text("select plan, status from public.workspace_billing where workspace_id = :id"),
                {"id": workspace_id},
            )
        ).first()
        await session.execute(
            text(
                "insert into public.workspace_billing "
                "(workspace_id, stripe_customer_id, stripe_subscription_id, plan, status, "
                " current_period_end) "
                "values (cast(:id as uuid), :cus, :sub, :plan, :status, :cpe) "
                "on conflict (workspace_id) do update set "
                "  stripe_customer_id = coalesce(excluded.stripe_customer_id, "
                "                                workspace_billing.stripe_customer_id), "
                "  stripe_subscription_id = coalesce(excluded.stripe_subscription_id, "
                "                                    workspace_billing.stripe_subscription_id), "
                "  plan = excluded.plan, status = excluded.status, "
                "  current_period_end = coalesce(excluded.current_period_end, "
                "                                workspace_billing.current_period_end)"
            ),
            {
                "id": workspace_id,
                "cus": stripe_customer_id,
                "sub": stripe_subscription_id,
                "plan": plan,
                "status": status,
                "cpe": current_period_end,
            },
        )
        # Workspace API (GET /workspaces*) の plan 表示も追随させる
        await session.execute(
            text("update public.workspaces set plan = :plan where id = :id"),
            {"plan": plan, "id": workspace_id},
        )
        changed = prev is None or (str(prev.plan), str(prev.status)) != (plan, status)
        if changed:
            await AuditWriter(session).write(
                AuditEvent(
                    action="billing.plan.change",
                    target_type="workspace_billing",
                    actor_type=actor_type,
                    actor_id=actor_id,
                    workspace_id=workspace_id,
                    target_id=workspace_id,
                    before=(
                        None
                        if prev is None
                        else {"plan": str(prev.plan), "status": str(prev.status)}
                    ),
                    after={"plan": plan, "status": status, "source": source},
                )
            )
        await session.commit()
        return changed


def _epoch_to_datetime(value: object) -> datetime | None:
    if isinstance(value, int | float):
        return datetime.fromtimestamp(value, tz=UTC)
    return None


async def apply_checkout_session(session_obj: dict[str, Any], *, source: str) -> str | None:
    """paid な checkout session を workspace_billing に反映する。

    Returns: 反映した workspace_id (paid でない / workspace 不明なら None)。
    """
    metadata = as_str_dict(session_obj.get("metadata"))
    workspace_id: object = metadata.get("workspace_id") or session_obj.get("client_reference_id")
    if not isinstance(workspace_id, str) or not is_uuid(workspace_id):
        return None
    if session_obj.get("payment_status") != "paid":
        return None
    customer = session_obj.get("customer")
    subscription = session_obj.get("subscription")
    await apply_billing_update(
        workspace_id=workspace_id,
        plan="pro",
        status="active",
        stripe_customer_id=customer if isinstance(customer, str) else None,
        stripe_subscription_id=subscription if isinstance(subscription, str) else None,
        source=source,
    )
    return workspace_id


async def apply_subscription_event(
    subscription_obj: dict[str, Any], *, deleted: bool, source: str
) -> str | None:
    """customer.subscription.updated / deleted を workspace_billing に反映する。"""
    metadata = as_str_dict(subscription_obj.get("metadata"))
    workspace_id: object = metadata.get("workspace_id")
    if not isinstance(workspace_id, str) or not is_uuid(workspace_id):
        return None
    raw_status = subscription_obj.get("status")
    status = raw_status if isinstance(raw_status, str) else "canceled"
    if deleted:
        status = "canceled"
    plan = "pro" if (not deleted and status in _PRO_STATUSES) else "free"
    customer = subscription_obj.get("customer")
    sub_id = subscription_obj.get("id")
    await apply_billing_update(
        workspace_id=workspace_id,
        plan=plan,
        status=status,
        stripe_customer_id=customer if isinstance(customer, str) else None,
        stripe_subscription_id=sub_id if isinstance(sub_id, str) else None,
        current_period_end=_epoch_to_datetime(subscription_obj.get("current_period_end")),
        source=source,
    )
    return workspace_id


async def handle_webhook_event(event: dict[str, Any]) -> str | None:
    """署名検証済み webhook イベントを反映する。対象外イベントは無視 (None)。"""
    event_type = event.get("type")
    obj = as_str_dict(as_str_dict(event.get("data")).get("object"))
    if event_type == "checkout.session.completed":
        return await apply_checkout_session(obj, source="webhook:checkout.session.completed")
    if event_type == "customer.subscription.updated":
        return await apply_subscription_event(
            obj, deleted=False, source="webhook:customer.subscription.updated"
        )
    if event_type == "customer.subscription.deleted":
        return await apply_subscription_event(
            obj, deleted=True, source="webhook:customer.subscription.deleted"
        )
    return None


async def write_checkout_audit(
    session: AsyncSession, *, actor_id: str, workspace_id: str, checkout_session_id: str
) -> None:
    """billing.checkout.create の audit (RLS session — メンバー本人の操作記録)。"""
    await AuditWriter(session).write(
        AuditEvent(
            action="billing.checkout.create",
            target_type="workspace_billing",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=workspace_id,
            target_id=workspace_id,
            after={"checkout_session_id": checkout_session_id},
        )
    )
