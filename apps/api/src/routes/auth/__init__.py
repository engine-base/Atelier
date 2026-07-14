"""認証 API ルータ (T-A-01〜05)。

T-A-01 signup + F-LEGAL-004 同意取得
T-A-02 signin + 5 回失敗ロック
T-A-03 Magic Link + OAuth (Google/GitHub)
T-A-04 パスワードリセット + JWT/refresh (refresh token rotate)
T-A-05 退会フロー (30 日猶予, F-LEGAL-002)

Supabase Auth admin API または DB direct insert / token audit_logs を
信頼源とする。token は sha256 hash で audit_logs に保管、plaintext は
発行時のみメール / response で返す (T-A-08 MCP token と同パターン)。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import text

from src.dependencies import CurrentUser, get_current_user
from src.rate_limit import rate_limit_ip
from src.schemas.auth import (
    AccountDeleteRequest,
    AccountDeleteResponse,
    AccountRestoreRequest,
    AccountRestoreResponse,
    MagicLinkAccepted,
    MagicLinkRequest,
    MagicLinkVerifyRequest,
    OAuthProvider,
    OAuthRedirectResponse,
    PasswordResetAccepted,
    PasswordResetConfirmRequest,
    PasswordResetConfirmResponse,
    PasswordResetRequest,
    RefreshRequest,
    RefreshResponse,
    SigninRequest,
    SigninResponse,
    SignupRequest,
    SignupResponse,
)
from src.services import auth as svc

router = APIRouter(tags=["auth"])


@router.post(
    "/auth/signup",
    status_code=status.HTTP_201_CREATED,
    summary="ユーザー登録 + 同意取得 (F-001 / F-LEGAL-004)",
)
async def signup(body: SignupRequest, request: Request) -> dict[str, SignupResponse]:
    ip = request.client.host if request.client else None
    ua: Annotated[str | None, "User-Agent"] = request.headers.get("user-agent")
    try:
        result = await svc.signup(data=body, ip_address=ip, user_agent=ua)
    except svc.SignupError as exc:
        if exc.code == "consent_missing":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, exc.message) from exc
        if exc.code == "email_taken":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}


@router.post(
    "/auth/signin",
    summary="ログイン + 5 回失敗ロック (F-001)",
    dependencies=[Depends(rate_limit_ip(5))],  # x-rate-limit: 5/min/ip
)
async def signin(body: SigninRequest, request: Request) -> dict[str, SigninResponse]:
    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent")
    try:
        result = await svc.signin(
            email=str(body.email),
            password=body.password,
            ip_address=ip,
            user_agent=ua,
        )
    except svc.SigninError as exc:
        if exc.code == "invalid_credentials":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
        if exc.code == "locked":
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}


# --------------------------------------------------------------------------- #
# T-A-03: Magic Link + OAuth
# --------------------------------------------------------------------------- #
def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


@router.post(
    "/auth/magic-link/request",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Magic Link 送信要求 (F-001)",
)
async def magic_link_request(
    body: MagicLinkRequest, request: Request
) -> dict[str, MagicLinkAccepted]:
    await svc.request_magic_link(
        email=str(body.email),
        redirect_url=body.redirect_url,
        ip_address=_client_ip(request),
    )
    return {"data": MagicLinkAccepted()}


@router.post(
    "/auth/magic-link/verify",
    summary="Magic Link 検証 → JWT 発行",
)
async def magic_link_verify(
    body: MagicLinkVerifyRequest, request: Request
) -> dict[str, SigninResponse]:
    try:
        result = await svc.verify_magic_link(
            email=str(body.email),
            token=body.token,
            ip_address=_client_ip(request),
        )
    except svc.MagicLinkError as exc:
        if exc.code == "invalid_token":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}


@router.get(
    "/auth/oauth/{provider}/redirect-url",
    summary="OAuth Provider 認可 URL 取得",
)
async def oauth_redirect(
    provider: OAuthProvider, request: Request
) -> dict[str, OAuthRedirectResponse]:
    try:
        authorize_url, state = await svc.build_oauth_redirect(
            provider=provider, ip_address=_client_ip(request)
        )
    except svc.MagicLinkError as exc:
        if exc.code == "unknown_provider":
            raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {
        "data": OAuthRedirectResponse(authorize_url=authorize_url, state=state, provider=provider)
    }


# --------------------------------------------------------------------------- #
# T-A-04: Password Reset + Refresh
# --------------------------------------------------------------------------- #
@router.post(
    "/auth/password-reset/request",
    status_code=status.HTTP_202_ACCEPTED,
    summary="パスワードリセット要求 (常に 202)",
)
async def password_reset_request(
    body: PasswordResetRequest, request: Request
) -> dict[str, PasswordResetAccepted]:
    await svc.request_password_reset(email=str(body.email), ip_address=_client_ip(request))
    return {"data": PasswordResetAccepted()}


@router.post(
    "/auth/password-reset/confirm",
    summary="パスワードリセット確定",
)
async def password_reset_confirm(
    body: PasswordResetConfirmRequest, request: Request
) -> dict[str, PasswordResetConfirmResponse]:
    try:
        result = await svc.confirm_password_reset(
            email=str(body.email),
            token=body.token,
            new_password=body.new_password,
            ip_address=_client_ip(request),
        )
    except svc.PasswordResetError as exc:
        if exc.code == "invalid_token":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}


@router.post(
    "/auth/refresh",
    summary="access_token 再発行 (refresh token rotate)",
)
async def auth_refresh(body: RefreshRequest, request: Request) -> dict[str, RefreshResponse]:
    try:
        result = await svc.refresh_access_token(
            refresh_token=body.refresh_token, ip_address=_client_ip(request)
        )
    except svc.PasswordResetError as exc:
        if exc.code == "invalid_refresh":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}


# --------------------------------------------------------------------------- #
# T-A-05: 退会 (30 日猶予, F-LEGAL-002)
# --------------------------------------------------------------------------- #
@router.post(
    "/auth/account/delete",
    summary="退会 (30 日猶予で soft-delete, F-LEGAL-002)",
)
async def account_delete(
    body: AccountDeleteRequest,
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
) -> dict[str, AccountDeleteResponse]:
    # email を user table から復元
    email_lookup_session_factory = svc._service_session_factory()  # pyright: ignore[reportPrivateUsage]
    async with email_lookup_session_factory() as s:
        res = await s.execute(
            text("select email from public.users where id = cast(:i as uuid)"),
            {"i": user.id},
        )
        row = res.first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    try:
        deleted_at, purge_at = await svc.delete_account(
            user_id=user.id,
            email=str(row.email),
            password=body.password,
            reason=body.reason,
            ip_address=_client_ip(request),
        )
    except svc.SigninError as exc:
        # password 不一致 → 401
        if exc.code == "invalid_credentials":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    except svc.AccountError as exc:
        if exc.code == "not_found_or_already_deleted":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {
        "data": AccountDeleteResponse(
            user_id=user.id,
            scheduled_purge_at=purge_at,
            deleted_at=deleted_at,
        )
    }


@router.post(
    "/auth/account/restore",
    summary="退会済アカウントの復活 (30 日猶予期間中)",
)
async def account_restore(
    body: AccountRestoreRequest, request: Request
) -> dict[str, AccountRestoreResponse]:
    try:
        uid, restored_at = await svc.restore_account(
            email=str(body.email),
            password=body.password,
            ip_address=_client_ip(request),
        )
    except svc.SigninError as exc:
        if exc.code == "invalid_credentials":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    except svc.AccountError as exc:
        if exc.code == "no_pending_deletion":
            raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
        if exc.code == "window_expired":
            raise HTTPException(status.HTTP_410_GONE, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": AccountRestoreResponse(user_id=uid, restored_at=restored_at)}
