"""課金 (Stripe) ルータ — GAP-021 (S-A03 プランタブ)。

エンドポイント:
  - GET  /billing/plan?workspace_id      … 現在プラン (+ stripe_configured)
  - POST /billing/checkout               … Checkout Session 実作成 → {url, session_id}
  - GET  /billing/checkout/{session_id}  … Stripe 照会 + paid なら pro へ反映 (ポーリング)
  - POST /billing/portal                 … Stripe カスタマーポータル (解約・支払方法変更)
  - POST /billing/webhook                … Stripe-Signature (HMAC v1) 検証済みイベント反映

R-T08: workspace 系 endpoint は RLS session で workspace 可視性を確認し、
非メンバーには一律 404 (存在自体を秘匿)。secret 未設定は 503 (偽の成功を出さない)。
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any, cast

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.errors import service_unavailable
from src.services import billing as svc
from src.services.billing import (
    BillingPlanResponse,
    CheckoutCreateRequest,
    CheckoutCreateResponse,
    CheckoutStatusResponse,
    PortalCreateRequest,
    PortalCreateResponse,
    StripeApiError,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["billing"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


async def _visible_or_404(session: AsyncSession, workspace_id: str) -> None:
    if not await svc.workspace_visible(session, workspace_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のワークスペースが見つかりません。")


@router.get("/billing/plan", summary="現在の課金プラン (行なし = free を誠実返却)")
async def get_plan(
    session: SessionDep,
    _user: UserDep,
    workspace_id: Annotated[str, Query()],
) -> dict[str, BillingPlanResponse]:
    await _visible_or_404(session, workspace_id)
    settings = svc.get_settings()
    plan = await svc.get_plan(
        session,
        workspace_id=workspace_id,
        stripe_configured=bool(settings.stripe_secret_key),
    )
    return {"data": plan}


@router.post(
    "/billing/checkout",
    status_code=status.HTTP_201_CREATED,
    summary="Stripe Checkout Session 作成 (mode=subscription / JPY 月額)",
)
async def create_checkout(
    body: CheckoutCreateRequest, session: SessionDep, user: UserDep
) -> dict[str, CheckoutCreateResponse]:
    await _visible_or_404(session, body.workspace_id)
    settings = svc.get_settings()
    if not settings.stripe_secret_key:
        # GAP-206: 503 は理由つきで返す (画面が「PC 未接続」と誤読しないため)。
        raise service_unavailable(
            "billing_unconfigured",
            "お支払いの取り扱いがまだ設定されていません。運営にお問い合わせください。",
        )
    # GAP-115: 登録済みメールを Stripe 決済画面に自動入力する (取得失敗時は
    # 未入力のまま = Stripe 側で入力させる誠実 fallback)
    email_res = await session.execute(
        text("select email from public.users where id = cast(:u as uuid)"),
        {"u": user.id},
    )
    email_row = email_res.first()
    customer_email = None if email_row is None else str(email_row.email)
    try:
        created = await svc.create_checkout_session(
            settings, workspace_id=body.workspace_id, customer_email=customer_email
        )
    except StripeApiError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "決済手続きを開始できませんでした。時間をおいて、もう一度お試しください。",
        ) from exc
    session_id = str(created.get("id", ""))
    url = str(created.get("url", ""))
    if not session_id or not url:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "決済手続きを開始できませんでした。時間をおいて、もう一度お試しください。",
        )
    await svc.write_checkout_audit(
        session,
        actor_id=user.id,
        workspace_id=body.workspace_id,
        checkout_session_id=session_id,
    )
    return {"data": CheckoutCreateResponse(url=url, session_id=session_id)}


@router.get(
    "/billing/checkout/{session_id}",
    summary="Checkout Session 照会 (paid なら pro へ反映 — 成功ページのポーリング用)",
)
async def get_checkout_status(
    session_id: str, session: SessionDep, user: UserDep
) -> dict[str, CheckoutStatusResponse]:
    settings = svc.get_settings()
    if not settings.stripe_secret_key:
        # GAP-206: 503 は理由つきで返す (画面が「PC 未接続」と誤読しないため)。
        raise service_unavailable(
            "billing_unconfigured",
            "お支払いの取り扱いがまだ設定されていません。運営にお問い合わせください。",
        )
    try:
        checkout = await svc.retrieve_checkout_session(settings, session_id=session_id)
    except StripeApiError as exc:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "決済手続きの状態を確認できませんでした。時間をおいて、もう一度お試しください。",
        ) from exc
    if checkout is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の決済手続きが見つかりません。")

    metadata = svc.as_str_dict(checkout.get("metadata"))
    workspace_id: object = metadata.get("workspace_id") or checkout.get("client_reference_id")
    if not isinstance(workspace_id, str) or not workspace_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の決済手続きが見つかりません。")
    # R-T08: 自分がメンバーの workspace の session でなければ存在ごと秘匿
    await _visible_or_404(session, workspace_id)

    if checkout.get("payment_status") == "paid":
        await svc.apply_checkout_session(checkout, source=f"poll:user:{user.id}")
    plan = await svc.get_plan(session, workspace_id=workspace_id, stripe_configured=True)
    return {
        "data": CheckoutStatusResponse(
            session_id=session_id,
            payment_status=str(checkout.get("payment_status", "unknown")),
            status=str(checkout.get("status", "unknown")),
            workspace_id=workspace_id,
            plan=plan.plan,
        )
    }


@router.post(
    "/billing/portal",
    summary="Stripe カスタマーポータル (解約・支払方法変更・領収書) の URL を発行",
    responses={
        409: {"description": "有料プランの契約が無い (解約するものが無い)"},
        503: {"description": "Stripe 未設定"},
    },
)
async def create_portal(
    body: PortalCreateRequest,
    session: SessionDep,
    _user: UserDep,
) -> dict[str, PortalCreateResponse]:
    """GAP-208: **やめる口**を用意する。

    これまでは申し込む口 (checkout) だけがあり、契約したあとに製品内で解約する
    手段が無かった。特定商取引法の観点でも、継続課金に解約手段が無いのは成立
    しない。Stripe のカスタマーポータルへ送ることで、解約・支払方法の変更・
    領収書の取得を本人が行える (当社が決済情報を預からずに済む)。
    """
    await _visible_or_404(session, body.workspace_id)
    settings = svc.get_settings()
    if not settings.stripe_secret_key:
        # GAP-206: 503 は理由つきで返す。
        raise service_unavailable(
            "billing_unconfigured",
            "お支払いの取り扱いがまだ設定されていません。運営にお問い合わせください。",
        )
    customer_id = await svc.get_billing_customer_id(session, workspace_id=body.workspace_id)
    if customer_id is None:
        # 無料プランには解約するものが無い。**死にボタンにしないため画面側は
        # Pro のときだけ導線を出す**が、直接叩かれたときも正直に断る。
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "有料プランのご契約がありません (無料プランに解約手続きは不要です)。",
        )
    try:
        portal = await svc.create_billing_portal_session(settings, customer_id=customer_id)
    except StripeApiError as exc:
        # GAP-225: str(exc) は "Stripe API error 500: <応答本文>"。
        # **決済事業者の応答をそのまま利用者に見せていた**ので、ログに回す。
        logger.error("Stripe portal session failed: %s", exc)
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "決済サービスとのやり取りに失敗しました。時間をおいて、もう一度お試しください。",
        ) from exc
    url = portal.get("url")
    if not isinstance(url, str) or not url:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "お支払い管理の画面を開けませんでした。時間をおいて、もう一度お試しください。",
        )
    return {"data": PortalCreateResponse(url=url)}


@router.post("/billing/webhook", summary="Stripe webhook (Stripe-Signature HMAC v1 検証)")
async def stripe_webhook(
    request: Request,
    stripe_signature: Annotated[str | None, Header(alias="Stripe-Signature")] = None,
) -> dict[str, object]:
    settings = svc.get_settings()
    if not settings.stripe_webhook_secret:
        # GAP-206: 503 は理由つきで返す。
        raise service_unavailable(
            "billing_unconfigured",
            "お支払いの取り扱いがまだ設定されていません。運営にお問い合わせください。",
        )
    payload = await request.body()
    if not svc.verify_webhook_signature(payload, stripe_signature, settings.stripe_webhook_secret):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "決済サービスからの通知を確認できませんでした。"
        )
    try:
        event: object = json.loads(payload)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "受け取った通知の形式が正しくありません。"
        ) from exc
    if not isinstance(event, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "受け取った通知の形式が正しくありません。")
    workspace_id = await svc.handle_webhook_event(cast("dict[str, Any]", event))
    return {"received": True, "workspace_id": workspace_id}
