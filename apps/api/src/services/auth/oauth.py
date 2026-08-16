"""OAuth サインイン (GAP-020 / S-A01) サービス層。

gap-tracker: 「OAuth 認可フロー (プロバイダ登録・コールバック・アカウント連付け)
の API + ボタン配線」。

プロバイダ汎用の Authorization Code フローを実装する (v1: google / github)。
有効判定は env のみが信頼源:

  - GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET
  - GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET

未設定プロバイダは「無効」= /providers 一覧に出さず、start/callback は 503
(偽装しない)。state は ATELIER_AUTH_JWT_SECRET で HS256 署名した短命 (10 分)
トークン (nonce 含む) で CSRF を防ぐ。

アカウント連付け (callback):
  1. oauth_accounts (provider, provider_user_id) 一致 → 当該 user でログイン
  2. email 一致の既存 public.users → oauth_accounts に行を追加して連付け
  3. どちらも無し → 新規 user 作成 (auth.users + public.users — signup と同手順)
その後、既存 signin と同一の JWT (services.auth._mint_access_token) を発行する。
audit は auth.oauth_signin 1 行に login_kind (created/linked/existing) を記録。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlencode

import httpx
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.auth import SigninResponse

from . import (
    _create_local_auth_user,  # pyright: ignore[reportPrivateUsage]
    _create_supabase_auth_user,  # pyright: ignore[reportPrivateUsage]
    _load_app_metadata,  # pyright: ignore[reportPrivateUsage]
    _mint_access_token,  # pyright: ignore[reportPrivateUsage]
    _normalize_ip,  # pyright: ignore[reportPrivateUsage]
    _service_session_factory,  # pyright: ignore[reportPrivateUsage]
)

_STATE_TTL_SECONDS = 600
"""state トークンの有効期限 (10 分)。"""

_HTTP_TIMEOUT_SECONDS = 20.0


class OAuthError(Exception):
    """OAuth フローの構造的失敗。route 層が code で 400/503/redirect に振り分ける。

    codes:
      - provider_disabled : env 未設定 (503)
      - invalid_state     : state 改竄 / 期限切れ / provider 不一致 (400)
      - email_unverified  : email 取得不可 / 未検証 (400 — 偽アカウントを作らない)
      - account_inactive  : 対象 user が退会済 (redirect ?error=)
      - exchange_failed   : code 交換 / プロフィール取得の失敗 (redirect ?error=)
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# --------------------------------------------------------------------------- #
# プロバイダ定義 (プロバイダ汎用: 追加はこの表に 1 行足す)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ProviderConfig:
    id: str
    display_name: str
    authorize_url: str
    token_url: str
    scope: str
    client_id_env: str
    client_secret_env: str


_PROVIDERS: dict[str, ProviderConfig] = {
    # 表示順 = モック S-A01-signin.html の .oauth-row (GitHub → Google)
    "github": ProviderConfig(
        id="github",
        display_name="GitHub",
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        scope="read:user user:email",
        client_id_env="GITHUB_OAUTH_CLIENT_ID",
        client_secret_env="GITHUB_OAUTH_CLIENT_SECRET",
    ),
    "google": ProviderConfig(
        id="google",
        display_name="Google",
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        scope="openid email profile",
        client_id_env="GOOGLE_OAUTH_CLIENT_ID",
        client_secret_env="GOOGLE_OAUTH_CLIENT_SECRET",
    ),
}

_GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
_GITHUB_USER_URL = "https://api.github.com/user"
_GITHUB_EMAILS_URL = "https://api.github.com/user/emails"


class OAuthProviderInfo(BaseModel):
    """GET /auth/oauth/providers の 1 要素。"""

    id: str
    display_name: str


def _credentials(cfg: ProviderConfig) -> tuple[str, str] | None:
    """client_id / client_secret の組。どちらか未設定なら None (= 無効)。"""
    client_id = os.environ.get(cfg.client_id_env)
    client_secret = os.environ.get(cfg.client_secret_env)
    if not client_id or not client_secret:
        return None
    return client_id, client_secret


def enabled_providers() -> list[OAuthProviderInfo]:
    """env が揃っている有効プロバイダの一覧。両方無効なら空 (死にボタン禁止)。"""
    return [
        OAuthProviderInfo(id=cfg.id, display_name=cfg.display_name)
        for cfg in _PROVIDERS.values()
        if _credentials(cfg) is not None
    ]


def _require_enabled(provider: str) -> tuple[ProviderConfig, str, str]:
    """有効な provider の (config, client_id, client_secret)。無効は OAuthError。"""
    cfg = _PROVIDERS.get(provider)
    if cfg is None:  # route 層は Literal で弾くため通常到達しない (defense in depth)
        raise OAuthError("provider_disabled", f"unknown provider: {provider}")
    creds = _credentials(cfg)
    if creds is None:
        raise OAuthError(
            "provider_disabled",
            f"{cfg.display_name} OAuth is not configured "
            f"({cfg.client_id_env} / {cfg.client_secret_env})",
        )
    return cfg, creds[0], creds[1]


def api_base_url() -> str:
    """API 自身の公開 base URL。redirect_uri の組み立てに使う。

    プロバイダのコンソールに登録する redirect URI は
    {ATELIER_API_BASE_URL}/auth/oauth/{provider}/callback。
    """
    return os.environ.get("ATELIER_API_BASE_URL", "http://127.0.0.1:8000").rstrip("/")


def web_base_url() -> str:
    """web (Next.js) の公開 base URL。callback 後の着地先に使う。

    既存の magic link / client invitation と同じく ATELIER_PUBLIC_BASE_URL が信頼源。
    """
    return os.environ.get("ATELIER_PUBLIC_BASE_URL", "http://localhost:3000").rstrip("/")


def redirect_uri_for(provider: str) -> str:
    return f"{api_base_url()}/auth/oauth/{provider}/callback"


# --------------------------------------------------------------------------- #
# state: ATELIER_AUTH_JWT_SECRET で署名した短命 (10 分) トークン (CSRF guard)
# --------------------------------------------------------------------------- #
def _state_secret() -> bytes:
    secret = os.environ.get("ATELIER_AUTH_JWT_SECRET")
    if not secret:
        raise OAuthError("provider_disabled", "ATELIER_AUTH_JWT_SECRET is not set")
    return secret.encode("utf-8")


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def encode_state(provider: str, *, ttl_seconds: int = _STATE_TTL_SECONDS) -> str:
    """署名付き state を発行。payload = {typ, provider, nonce, exp}。"""
    payload = _b64url_encode(
        json.dumps(
            {
                "typ": "oauth_state",
                "provider": provider,
                "nonce": secrets.token_urlsafe(16),
                "exp": int(time.time()) + ttl_seconds,
            }
        ).encode("utf-8")
    )
    sig = _b64url_encode(
        hmac.new(_state_secret(), payload.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{payload}.{sig}"


def verify_state(state: str, *, provider: str) -> None:
    """state を検証。改竄 / 期限切れ / provider 不一致は OAuthError('invalid_state')。"""
    parts = state.split(".")
    if len(parts) != 2:
        raise OAuthError("invalid_state", "malformed state")
    payload_b64, sig = parts
    expected = _b64url_encode(
        hmac.new(_state_secret(), payload_b64.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(expected, sig):
        raise OAuthError("invalid_state", "state signature mismatch")
    try:
        payload_raw: object = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError) as exc:
        raise OAuthError("invalid_state", "state payload is not valid JSON") from exc
    if not isinstance(payload_raw, dict):
        raise OAuthError("invalid_state", "state payload is not an object")
    payload = cast("dict[str, Any]", payload_raw)
    if payload.get("typ") != "oauth_state" or payload.get("provider") != provider:
        raise OAuthError("invalid_state", "state does not match this provider")
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp <= int(time.time()):
        raise OAuthError("invalid_state", "state expired")


def build_authorize_url(provider: str) -> str:
    """有効プロバイダの認可 URL (署名 state 込み)。無効は OAuthError('provider_disabled')。"""
    cfg, client_id, _ = _require_enabled(provider)
    query = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri_for(provider),
            "response_type": "code",
            "scope": cfg.scope,
            "state": encode_state(provider),
        }
    )
    return f"{cfg.authorize_url}?{query}"


# --------------------------------------------------------------------------- #
# code 交換 → プロフィール取得 (httpx)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class OAuthIdentity:
    """プロバイダから取得した検証済み identity。email は必ず verified。"""

    provider: str
    provider_user_id: str
    email: str
    display_name: str


def _http_client() -> httpx.AsyncClient:
    """外部プロバイダ向け httpx client。テストは本関数を monkeypatch して偽装する。"""
    return httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS)


def _as_dict(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OAuthError("exchange_failed", "unexpected response shape from provider")
    return cast("dict[str, Any]", value)


async def _exchange_code(
    client: httpx.AsyncClient,
    *,
    cfg: ProviderConfig,
    client_id: str,
    client_secret: str,
    code: str,
) -> str:
    """authorization code を access_token に交換。失敗は OAuthError('exchange_failed')。"""
    r = await client.post(
        cfg.token_url,
        headers={"Accept": "application/json"},
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": redirect_uri_for(cfg.id),
            "grant_type": "authorization_code",
        },
    )
    if r.status_code >= 400:
        raise OAuthError(
            "exchange_failed",
            f"{cfg.display_name} token endpoint failed: {r.status_code} {r.text[:200]}",
        )
    body = _as_dict(r.json())
    token = body.get("access_token")
    if not isinstance(token, str) or not token:
        raise OAuthError("exchange_failed", f"{cfg.display_name} returned no access_token")
    return token


async def _fetch_identity_google(client: httpx.AsyncClient, *, access_token: str) -> OAuthIdentity:
    """google: userinfo エンドポイントで sub/email/email_verified/name を取得。"""
    r = await client.get(_GOOGLE_USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
    if r.status_code >= 400:
        raise OAuthError("exchange_failed", f"google userinfo failed: {r.status_code}")
    body = _as_dict(r.json())
    sub = body.get("sub")
    if not isinstance(sub, str) or not sub:
        raise OAuthError("exchange_failed", "google userinfo returned no sub")
    email = body.get("email")
    verified = body.get("email_verified")
    if not isinstance(email, str) or not email or verified is not True:
        # email 不在 / 未検証で偽アカウントを作らない
        raise OAuthError("email_unverified", "google account has no verified email")
    name = body.get("name")
    display_name = name if isinstance(name, str) and name else email.split("@")[0]
    return OAuthIdentity(
        provider="google", provider_user_id=sub, email=email, display_name=display_name
    )


async def _fetch_identity_github(client: httpx.AsyncClient, *, access_token: str) -> OAuthIdentity:
    """github: /user + /user/emails (primary かつ verified のみ採用)。"""
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
    }
    r = await client.get(_GITHUB_USER_URL, headers=headers)
    if r.status_code >= 400:
        raise OAuthError("exchange_failed", f"github /user failed: {r.status_code}")
    user = _as_dict(r.json())
    uid = user.get("id")
    if not isinstance(uid, int):
        raise OAuthError("exchange_failed", "github /user returned no id")

    re_ = await client.get(_GITHUB_EMAILS_URL, headers=headers)
    if re_.status_code >= 400:
        raise OAuthError("exchange_failed", f"github /user/emails failed: {re_.status_code}")
    emails_raw: object = re_.json()
    email: str | None = None
    if isinstance(emails_raw, list):
        for entry_raw in cast("list[object]", emails_raw):
            if not isinstance(entry_raw, dict):
                continue
            entry = cast("dict[str, Any]", entry_raw)
            addr = entry.get("email")
            if (
                entry.get("primary") is True
                and entry.get("verified") is True
                and isinstance(addr, str)
                and addr
            ):
                email = addr
                break
    if email is None:
        raise OAuthError("email_unverified", "github account has no primary verified email")

    name = user.get("name")
    login = user.get("login")
    if isinstance(name, str) and name:
        display_name = name
    elif isinstance(login, str) and login:
        display_name = login
    else:
        display_name = email.split("@")[0]
    return OAuthIdentity(
        provider="github", provider_user_id=str(uid), email=email, display_name=display_name
    )


async def fetch_identity(provider: str, *, code: str) -> OAuthIdentity:
    """code 交換 → プロフィール取得までを 1 呼び出しで行う。"""
    cfg, client_id, client_secret = _require_enabled(provider)
    async with _http_client() as client:
        access_token = await _exchange_code(
            client, cfg=cfg, client_id=client_id, client_secret=client_secret, code=code
        )
        if provider == "google":
            return await _fetch_identity_google(client, access_token=access_token)
        return await _fetch_identity_github(client, access_token=access_token)


# --------------------------------------------------------------------------- #
# アカウント連付け + JWT 発行
# --------------------------------------------------------------------------- #
async def _create_user_for_identity(session: AsyncSession, identity: OAuthIdentity) -> str:
    """OAuth 新規ユーザー作成 (signup と同手順: auth.users → public.users)。

    password は本人も知らないランダム値 (パスワードログイン不可、OAuth 専用)。
    Supabase Admin API が設定されていればそれを優先、無ければ DB direct path。
    """
    random_password = secrets.token_urlsafe(32)
    uid = await _create_supabase_auth_user(email=identity.email, password=random_password)
    if uid is None:
        uid = await _create_local_auth_user(session, email=identity.email, password=random_password)
    await session.execute(
        text(
            "insert into public.users (id, email, display_name) values (cast(:i as uuid), :e, :d)"
        ),
        {"i": uid, "e": identity.email, "d": identity.display_name},
    )
    return uid


async def _link_oauth_account(
    session: AsyncSession, *, user_id: str, identity: OAuthIdentity
) -> None:
    await session.execute(
        text(
            "insert into public.oauth_accounts (user_id, provider, provider_user_id, email) "
            "values (cast(:u as uuid), :p, :pid, :e)"
        ),
        {
            "u": user_id,
            "p": identity.provider,
            "pid": identity.provider_user_id,
            "e": identity.email,
        },
    )


async def signin_with_identity(
    identity: OAuthIdentity,
    *,
    ip_address: str | None,
) -> SigninResponse:
    """アカウント連付けを解決して既存 signin と同一の JWT を発行する。

    連付け順:
      1. oauth_accounts (provider, provider_user_id) → existing
      2. email 一致の既存 user → linked (oauth_accounts に行追加)
      3. どちらも無し → created (auth.users + public.users + oauth_accounts)
    audit: auth.oauth_signin (after.login_kind に区別を記録)。
    """
    normalized_ip = _normalize_ip(ip_address)
    now_epoch = int(time.time())
    factory = _service_session_factory()
    async with factory() as session:
        try:
            res = await session.execute(
                text(
                    "select user_id::text as uid from public.oauth_accounts "
                    "where provider = :p and provider_user_id = :pid"
                ),
                {"p": identity.provider, "pid": identity.provider_user_id},
            )
            found = res.first()
            if found is not None:
                uid = str(found.uid)
                login_kind = "existing"
            else:
                res = await session.execute(
                    text("select id::text as uid, deleted_at from public.users where email = :e"),
                    {"e": identity.email},
                )
                by_email = res.first()
                if by_email is not None and by_email.deleted_at is not None:
                    raise OAuthError("account_inactive", "account is deactivated")
                if by_email is not None:
                    uid = str(by_email.uid)
                    login_kind = "linked"
                else:
                    uid = await _create_user_for_identity(session, identity)
                    login_kind = "created"
                await _link_oauth_account(session, user_id=uid, identity=identity)

            res = await session.execute(
                text(
                    "select id, email, display_name, deleted_at "
                    "from public.users where id = cast(:i as uuid)"
                ),
                {"i": uid},
            )
            row = res.first()
            if row is None or row.deleted_at is not None:
                raise OAuthError("account_inactive", "account is deactivated")

            app_meta = await _load_app_metadata(session, user_id=uid)
            token, expires_at = _mint_access_token(
                user_id=uid, now=now_epoch, app_metadata=app_meta
            )

            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.oauth_signin",
                    target_type="user",
                    actor_type="user",
                    actor_id=uid,
                    target_id=uid,
                    ip_address=normalized_ip,
                    after={
                        "email": identity.email,
                        "provider": identity.provider,
                        "provider_user_id": identity.provider_user_id,
                        "login_kind": login_kind,
                    },
                )
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise

    return SigninResponse(
        access_token=token,
        token_type="bearer",
        expires_at=expires_at,
        user_id=str(row.id),
        email=str(row.email),
        display_name=(None if row.display_name is None else str(row.display_name)),
    )


def complete_redirect_url(result: SigninResponse) -> str:
    """成功時に web /auth/oauth-complete へ返す URL (トークンはフラグメントで受け渡し)。

    フラグメントはサーバーログ / Referer に漏れない。web 側は既存 signin と
    同じ cookie 格納方式 (atelier_access) で保存する。
    """
    fragment = urlencode(
        {
            "access_token": result.access_token,
            "expires_at": result.expires_at.isoformat(),
            "user_id": result.user_id,
            "email": result.email,
            "display_name": result.display_name or "",
        }
    )
    return f"{web_base_url()}/auth/oauth-complete#{fragment}"


def error_redirect_url(error_code: str) -> str:
    """失敗時に web /auth/oauth-complete へ誠実にエラーを渡す URL。"""
    return f"{web_base_url()}/auth/oauth-complete?{urlencode({'error': error_code})}"
