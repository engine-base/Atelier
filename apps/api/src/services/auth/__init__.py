"""認証 (signup + 同意取得) サービス層 (T-A-01)。

Supabase Auth (auth.users) と public.users / consents を atomic に作成する。
signup は JWT を持たないため service_role 相当のセッションが必要 (RLS を
バイパス)。Supabase Admin API を直接叩く本番経路と、test 環境で
auth.users を直接 insert するローカル経路の両方をサポート。

ATELIER_SUPABASE_ADMIN_API_URL + ATELIER_SUPABASE_SERVICE_ROLE_KEY が
両方設定されている場合のみ Supabase Admin API を使い、それ以外 (test /
dev) は DB direct insert path を使う。

F-LEGAL-004: terms_of_service と privacy_policy は accepted=True 必須、
それ以外は任意。consents は append-only なので version で履歴を残す。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import time
import uuid
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Any, cast

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.db.session import create_engine, create_session_factory
from src.schemas.auth import (
    ConsentEntry,
    PasswordResetConfirmResponse,
    RefreshResponse,
    SigninResponse,
    SignupRequest,
    SignupResponse,
)

logger = logging.getLogger(__name__)


def _normalize_ip(ip: str | None) -> str | None:
    """ip_address (inet) として受け入れ可能かを確認し、不正なら None を返す。

    TestClient の "testclient" のような非-IP リテラルは drop して NULL 化する
    (auth.signup の本質は consents 取得であり、不正な IP で signup を落とさない)。
    """
    if ip is None:
        return None
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return None
    return ip


class SignupError(Exception):
    """signup 操作で構造的に失敗 (重複 email / consents 未満 / Supabase API)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_REQUIRED_CONSENT_TYPES = ("terms_of_service", "privacy_policy")


def _validate_consents(consents: list[ConsentEntry]) -> None:
    """terms_of_service / privacy_policy が accepted=True で揃っているか。"""
    by_type = {c.type: c for c in consents}
    for required in _REQUIRED_CONSENT_TYPES:
        if required not in by_type or not by_type[required].accepted:
            raise SignupError(
                "consent_missing",
                f"{required} must be accepted",
            )


@lru_cache(maxsize=8)
def _session_factory_for_loop(loop_key: int) -> async_sessionmaker[AsyncSession]:
    """service_role 相当の sessionmaker。RLS バイパス用 (role を下げない)。

    asyncpg の接続は event loop を跨いで再利用できないため、実行中 loop 毎に
    engine を分離してキャッシュする (本番 uvicorn は単一 loop で挙動不変。
    テストの TestClient はブロック毎に新 loop を作るため必須)。
    """
    del loop_key  # cache key 専用
    return create_session_factory(create_engine())


def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    """実行中 event loop に紐づく sessionmaker を返す。"""
    return _session_factory_for_loop(id(asyncio.get_running_loop()))


_service_session_factory.cache_clear = (  # pyright: ignore[reportAttributeAccessIssue, reportFunctionMemberAccess]
    _session_factory_for_loop.cache_clear
)


async def _create_supabase_auth_user(*, email: str, password: str) -> str | None:
    """Supabase Admin API で auth.users を作成。設定無しなら None。"""
    api_url = os.environ.get("ATELIER_SUPABASE_ADMIN_API_URL")
    service_key = os.environ.get("ATELIER_SUPABASE_SERVICE_ROLE_KEY")
    if not api_url or not service_key:
        return None
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f"{api_url.rstrip('/')}/auth/v1/admin/users",
            headers={
                "Authorization": f"Bearer {service_key}",
                "apikey": service_key,
                "Content-Type": "application/json",
            },
            json={
                "email": email,
                "password": password,
                "email_confirm": True,
            },
        )
    if r.status_code == 422 or r.status_code == 409:
        raise SignupError("email_taken", "email already registered")
    if r.status_code >= 400:
        raise SignupError(
            "supabase_admin_error",
            f"Supabase Admin API failed: {r.status_code} {r.text[:200]}",
        )
    body: dict[str, Any] = r.json()
    uid = body.get("id")
    if not isinstance(uid, str):
        raise SignupError("supabase_admin_error", "missing id from Supabase response")
    return uid


async def _delete_supabase_auth_user(uid: str) -> None:
    """補償トランザクション: signup の DB 部分が失敗した際に Supabase auth.users を削除する。

    バグ #26: 従来は DB 失敗時に session.rollback() のみで、外部 API で作成済みの
    auth.users が孤児化し、以後その email が「登録済み」で再登録も復旧もできなくなっていた。
    ベストエフォート (削除自体の失敗は握りつぶし、元の例外を優先する)。
    """
    api_url = os.environ.get("ATELIER_SUPABASE_ADMIN_API_URL")
    service_key = os.environ.get("ATELIER_SUPABASE_SERVICE_ROLE_KEY")
    if not api_url or not service_key:
        return
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            await client.delete(
                f"{api_url.rstrip('/')}/auth/v1/admin/users/{uid}",
                headers={"Authorization": f"Bearer {service_key}", "apikey": service_key},
            )
    except Exception as exc:  # 補償失敗は元例外を優先 (ログのみ)
        logger.warning("failed to roll back orphan supabase auth user %s: %s", uid, exc)


async def _create_local_auth_user(session: AsyncSession, *, email: str, password: str) -> str:
    """test / dev 環境用: auth.users に直接 insert (RLS バイパス済 session 前提)。

    本 path は Supabase 本番経路の代替で、test PG では auth.users スキーマが
    最小 (id, email, created_at) のため password は記録しない。実 hash 検証は
    T-A-02 signin で Supabase Auth に委譲する。本タスクでは email + id の
    1:1 リンクのみ確立する責務。
    """
    new_id = str(uuid.uuid4())
    dup = await session.execute(
        text("select 1 from auth.users where email = :e"),
        {"e": email},
    )
    if dup.first() is not None:
        raise SignupError("email_taken", "email already registered")
    # dev/test 経路: sha256 hash を encrypted_password に保存する。
    # signin の _verify_password_local が同じ sha256 で照合するため、保存しないと
    # ローカルで signin が必ず invalid_credentials になる (本番は Supabase が bcrypt)。
    pw_hash = hashlib.sha256(password.encode("utf-8")).hexdigest()
    await session.execute(
        text(
            "insert into auth.users (id, email, encrypted_password) "
            "values (cast(:i as uuid), :e, :p)"
        ),
        {"i": new_id, "e": email, "p": pw_hash},
    )
    return new_id


async def signup(
    *,
    data: SignupRequest,
    ip_address: str | None,
    user_agent: str | None,
) -> SignupResponse:
    """signup の本体。

    無認証 endpoint なので JWT 検証セッションは渡らない。service_role
    相当のフルアクセス session を内部 factory から払い出して使う。
    Supabase Admin API が設定されていればそれを優先、無ければ
    DB direct insert path を使う。両 path とも以下を実行:
    1. auth.users 作成
    2. public.users 作成 (FK で auth.users.id とリンク)
    3. consents N 件 append (4 種上限、type は enum)
    4. audit_logs に auth.signup を記録

    Raises SignupError (route 層が 409/422/500 に振り分ける)。
    """
    _validate_consents(data.consents)
    normalized_ip = _normalize_ip(ip_address)

    # service_role session を直接 factory から取得 (RLS バイパス)
    factory = _service_session_factory()
    supabase_uid: str | None = None  # 補償対象 (Supabase 経由で作成した場合のみ)
    async with factory() as session:
        try:
            uid = await _create_supabase_auth_user(email=str(data.email), password=data.password)
            if uid is None:
                uid = await _create_local_auth_user(
                    session, email=str(data.email), password=data.password
                )
            else:
                supabase_uid = uid
                # Supabase に既に作成済 → public.users 作成のため重複チェック
                dup = await session.execute(
                    text("select 1 from public.users where email = :e"),
                    {"e": str(data.email)},
                )
                if dup.first() is not None:
                    raise SignupError("email_taken", "email already registered")

            # public.users
            await session.execute(
                text(
                    "insert into public.users (id, email, display_name) "
                    "values (cast(:i as uuid), :e, :d)"
                ),
                {"i": uid, "e": str(data.email), "d": data.display_name},
            )

            # consents (append-only)
            for c in data.consents:
                consent_id = str(uuid.uuid4())
                await session.execute(
                    text(
                        "insert into public.consents "
                        "(id, user_id, type, version, accepted, ip_address, user_agent) "
                        "values (cast(:i as uuid), cast(:u as uuid), "
                        "cast(:t as consent_type_enum), :v, :a, "
                        "cast(:ip as inet), :ua)"
                    ),
                    {
                        "i": consent_id,
                        "u": uid,
                        "t": c.type,
                        "v": c.version,
                        "a": c.accepted,
                        "ip": normalized_ip,
                        "ua": user_agent,
                    },
                )

            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.signup",
                    target_type="user",
                    actor_type="user",
                    actor_id=uid,
                    target_id=uid,
                    after={
                        "email": str(data.email),
                        "consent_types": [c.type for c in data.consents],
                        "consents_recorded": len(data.consents),
                    },
                )
            )

            res = await session.execute(
                text(
                    "select id, email, display_name, created_at "
                    "from public.users where id = cast(:i as uuid)"
                ),
                {"i": uid},
            )
            row = res.first()
            if row is None:  # pragma: no cover
                raise SignupError("post_insert_missing", "created user not visible")

            await session.commit()
        except Exception as exc:
            await session.rollback()
            # 補償: DB 部分が失敗したら外部で作成済みの Supabase auth.users も消す。
            # email_taken は「既存ユーザー = 我々が作っていない」ので対象外。
            is_email_taken = isinstance(exc, SignupError) and exc.code == "email_taken"
            if supabase_uid is not None and not is_email_taken:
                await _delete_supabase_auth_user(supabase_uid)
            raise

    return SignupResponse(
        user_id=str(row.id),
        email=str(row.email),
        display_name=str(row.display_name),
        consents_recorded=len(data.consents),
        created_at=row.created_at,
    )


# --------------------------------------------------------------------------- #
# T-A-02: signin + 5 回失敗ロック
# --------------------------------------------------------------------------- #
_LOCKOUT_THRESHOLD = 5
"""連続失敗がこの回数に達すると一時ロック (F-001)。"""

_LOCKOUT_WINDOW_MINUTES = 15
"""ロック判定の時間窓。直近 N 分の失敗回数を数える。"""

_ACCESS_TOKEN_TTL_SECONDS = int(os.environ.get("ATELIER_ACCESS_TOKEN_TTL_SECONDS", "28800"))
"""access_token (HS256 JWT) の有効期限(秒)。

既定 8h。1h だと長い作業(通し検証・長い商談チャット)の途中でセッションが切れ、
クライアント側 refresh が未配線のため強制再ログインになっていた。env
ATELIER_ACCESS_TOKEN_TTL_SECONDS で調整可能(短命化してリスクを下げることも可能)。"""


class SigninError(Exception):
    """signin 操作の構造的失敗。code で route が 401 / 429 に振り分ける。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_access_token(
    *, user_id: str, now: int, app_metadata: dict[str, Any] | None = None
) -> tuple[str, datetime]:
    """decode_supabase_jwt (src.dependencies) と互換の HS256 JWT を発行する。

    secret は ATELIER_AUTH_JWT_SECRET。sub=user_id, role/aud='authenticated',
    exp=now+TTL。本番 Supabase Auth 経路では Supabase が発行する JWT を
    そのまま返すため、本 mint は dev/test 経路専用。

    app_metadata: Supabase 発行 JWT と同形の claim。**信頼源は DB
    (auth.users.raw_app_meta_data) のみ**で、ユーザー入力からは絶対に受け取らない。
    services.admin.is_admin が app_metadata.role=='admin' を見るため、これを載せないと
    DB で admin を付与しても運営コンソールに到達できない (実際に到達不能だった)。
    """
    secret = os.environ.get("ATELIER_AUTH_JWT_SECRET")
    if not secret:
        raise SigninError("auth_not_configured", "ATELIER_AUTH_JWT_SECRET is not set")
    exp = now + _ACCESS_TOKEN_TTL_SECONDS
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    claims: dict[str, Any] = {
        "sub": user_id,
        "role": "authenticated",
        "aud": "authenticated",
        "exp": exp,
    }
    if app_metadata:
        claims["app_metadata"] = app_metadata
    payload = _b64url(json.dumps(claims).encode())
    sig = _b64url(
        hmac.new(
            secret.encode("utf-8"), f"{header}.{payload}".encode("ascii"), hashlib.sha256
        ).digest()
    )
    token = f"{header}.{payload}.{sig}"
    return token, datetime.fromtimestamp(exp, tz=UTC)


async def _load_app_metadata(session: AsyncSession, *, user_id: str) -> dict[str, Any] | None:
    """auth.users.raw_app_meta_data から JWT に載せる app_metadata を取り出す。

    **信頼源は DB のみ** (service_role session で読む)。ユーザー入力は一切参照しない。
    現状 JWT に必要なのは role (services.admin.is_admin が参照) だけなので role のみ写す。
    role が無い/読めない場合は None を返し、従来どおり app_metadata 無しで発行する。
    """
    try:
        res = await session.execute(
            text(
                "select coalesce(raw_app_meta_data->>'role', '') as role "
                "from auth.users where id = cast(:i as uuid)"
            ),
            {"i": user_id},
        )
        row = res.first()
    except Exception:
        return None
    if row is None or not row.role:
        return None
    return {"role": row.role}


async def _count_recent_failures(session: AsyncSession, *, email: str) -> int:
    """直近 _LOCKOUT_WINDOW_MINUTES 分の auth.signin_failed を email 単位で数える。"""
    res = await session.execute(
        text(
            "select count(*) from public.audit_logs "
            "where action = 'auth.signin_failed' "
            "and actor_id = :email "
            "and created_at > now() - make_interval(mins => :w)"
        ),
        {"email": email, "w": _LOCKOUT_WINDOW_MINUTES},
    )
    return int(res.scalar_one())


async def _verify_password_supabase(*, email: str, password: str) -> str | None:
    """Supabase Auth token endpoint で password 検証。設定無しなら None。

    成功時 user.id を返す。資格情報不正なら SigninError('invalid_credentials')。
    """
    api_url = os.environ.get("ATELIER_SUPABASE_ADMIN_API_URL")
    anon_key = os.environ.get("ATELIER_SUPABASE_ANON_KEY") or os.environ.get(
        "ATELIER_SUPABASE_SERVICE_ROLE_KEY"
    )
    if not api_url or not anon_key:
        return None
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f"{api_url.rstrip('/')}/auth/v1/token?grant_type=password",
            headers={"apikey": anon_key, "Content-Type": "application/json"},
            json={"email": email, "password": password},
        )
    if r.status_code == 400 or r.status_code == 401:
        raise SigninError("invalid_credentials", "invalid email or password")
    if r.status_code >= 400:
        raise SigninError(
            "supabase_auth_error",
            f"Supabase token endpoint failed: {r.status_code} {r.text[:200]}",
        )
    body: dict[str, Any] = r.json()
    user_raw = body.get("user")
    user_dict = cast("dict[str, Any]", user_raw) if isinstance(user_raw, dict) else {}
    uid = user_dict.get("id")
    if not isinstance(uid, str):
        raise SigninError("supabase_auth_error", "missing user id from Supabase response")
    return uid


async def _verify_password_local(session: AsyncSession, *, email: str, password: str) -> str:
    """dev/test 経路: stub auth.users.encrypted_password (sha256) と照合。

    本番では Supabase が bcrypt 検証するため本 path は使われない。test stub
    の auth.users に encrypted_password 列がある前提 (test fixture が用意)。
    user 不在 / hash 不一致は invalid_credentials (どちらも同一応答で
    user-enumeration を防ぐ)。
    """
    res = await session.execute(
        text("select id, encrypted_password from auth.users where email = :e"),
        {"e": email},
    )
    row = res.first()
    if row is None or row.encrypted_password is None:
        raise SigninError("invalid_credentials", "invalid email or password")
    expected = str(row.encrypted_password)
    actual = hashlib.sha256(password.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(expected, actual):
        raise SigninError("invalid_credentials", "invalid email or password")
    return str(row.id)


async def signin(
    *,
    email: str,
    password: str,
    ip_address: str | None,
    user_agent: str | None,
) -> SigninResponse:
    """signin の本体。5 回失敗ロック + JWT 発行。

    1. 直近 15 分の失敗回数を audit_logs から数え、>= 5 なら locked (429)
    2. password 検証 (Supabase Auth 経路 or local stub)
       - 失敗: audit_logs に auth.signin_failed を記録して invalid_credentials
       - 成功: audit_logs に auth.signin を記録して JWT 発行
    3. public.users から表示用情報を取得 (soft-deleted は invalid_credentials)

    全 path で service_role session を使う (RLS バイパス、pre-auth ゆえ)。
    Raises SigninError (route が 401 / 429 / 500 に振り分ける)。
    """
    normalized_ip = _normalize_ip(ip_address)
    now_epoch = int(time.time())
    factory = _service_session_factory()
    async with factory() as session:
        try:
            # 1. lockout チェック
            failures = await _count_recent_failures(session, email=email)
            if failures >= _LOCKOUT_THRESHOLD:
                await AuditWriter(session).write(
                    AuditEvent(
                        action="auth.signin_locked",
                        target_type="user",
                        actor_type="anonymous",
                        actor_id=email,
                        ip_address=normalized_ip,
                        after={"email": email, "failures": failures},
                    )
                )
                await session.commit()
                raise SigninError(
                    "locked",
                    f"account temporarily locked after {failures} failed attempts",
                )

            # 2. password 検証
            try:
                uid = await _verify_password_supabase(email=email, password=password)
                if uid is None:
                    uid = await _verify_password_local(session, email=email, password=password)
            except SigninError as exc:
                if exc.code == "invalid_credentials":
                    await AuditWriter(session).write(
                        AuditEvent(
                            action="auth.signin_failed",
                            target_type="user",
                            actor_type="anonymous",
                            actor_id=email,
                            ip_address=normalized_ip,
                            after={"email": email, "user_agent": user_agent},
                        )
                    )
                    await session.commit()
                raise

            # 3. public.users 取得 (soft-deleted は拒否)
            res = await session.execute(
                text(
                    "select id, email, display_name, deleted_at "
                    "from public.users where id = cast(:i as uuid)"
                ),
                {"i": uid},
            )
            row = res.first()
            if row is None or row.deleted_at is not None:
                await AuditWriter(session).write(
                    AuditEvent(
                        action="auth.signin_failed",
                        target_type="user",
                        actor_type="anonymous",
                        actor_id=email,
                        ip_address=normalized_ip,
                        after={"email": email, "reason": "user_inactive"},
                    )
                )
                await session.commit()
                raise SigninError("invalid_credentials", "invalid email or password")

            app_meta = await _load_app_metadata(session, user_id=str(row.id))
            token, expires_at = _mint_access_token(
                user_id=str(row.id), now=now_epoch, app_metadata=app_meta
            )

            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.signin",
                    target_type="user",
                    actor_type="user",
                    actor_id=str(row.id),
                    target_id=str(row.id),
                    ip_address=normalized_ip,
                    after={"email": email},
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


# secrets は T-A-03/04 (Magic Link / refresh token) で token 生成に使う予約
_ = secrets


# --------------------------------------------------------------------------- #
# T-A-03 / T-A-04 / T-A-05: 共通の token / hash ヘルパ
# --------------------------------------------------------------------------- #
def _hash_token(token: str) -> str:
    """token の sha256 hex (audit_logs に保存)。"""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_opaque_token(*, nbytes: int = 32) -> tuple[str, str]:
    """opaque token を発行。(plaintext, sha256-hash) を返す。"""
    plain = secrets.token_urlsafe(nbytes)
    return plain, _hash_token(plain)


_MAGIC_LINK_TTL_MINUTES = 15
_PASSWORD_RESET_TTL_MINUTES = 30
_REFRESH_TOKEN_TTL_DAYS = 30
_ACCOUNT_GRACE_DAYS = 30


async def _emit_token_audit(
    session: AsyncSession,
    *,
    action: str,
    email: str,
    token_hash: str,
    ttl_minutes: int,
    ip_address: str | None,
    extra: dict[str, object] | None = None,
) -> str:
    """token 発行系の audit_logs を 1 行 INSERT。target_id (uuid) は生成。"""
    audit_id = str(uuid.uuid4())
    after: dict[str, object] = {
        "email": email,
        "token_hash": token_hash,
        "expires_epoch": int(time.time()) + ttl_minutes * 60,
    }
    if extra:
        after.update(extra)
    await AuditWriter(session).write(
        AuditEvent(
            action=action,
            target_type="auth_token",
            actor_type="anonymous",
            actor_id=email,
            target_id=audit_id,
            ip_address=ip_address,
            after=after,
        )
    )
    return audit_id


async def _find_active_token(
    session: AsyncSession,
    *,
    action_issued: str,
    action_consumed: str,
    email: str,
    token_hash: str,
) -> str | None:
    """発行済みかつ未消費かつ未失効の token audit を検索し、target_id を返す。

    検索条件:
      - issued: action = action_issued AND actor_id = email AND
                after->>'token_hash' = token_hash AND expires_epoch > now
      - consumed: action = action_consumed AND target_id = issued.target_id
                  が無いこと
    """
    now_epoch = int(time.time())
    res = await session.execute(
        text(
            "select target_id::text as tid from public.audit_logs "
            "where action = :issued and actor_id = :em "
            "and (after->>'token_hash') = :h "
            "and (after->>'expires_epoch')::bigint > :now "
            "and not exists ("
            "  select 1 from public.audit_logs c "
            "  where c.action = :consumed and c.target_id = public.audit_logs.target_id"
            ") "
            "order by created_at desc limit 1"
        ),
        {
            "issued": action_issued,
            "consumed": action_consumed,
            "em": email,
            "h": token_hash,
            "now": now_epoch,
        },
    )
    row = res.first()
    return None if row is None else str(row.tid)


# --------------------------------------------------------------------------- #
# T-A-03: Magic Link + OAuth
# --------------------------------------------------------------------------- #
class MagicLinkError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _send_magic_link_email(*, email: str, link: str) -> None:
    """Magic Link メール送信のスタブ。ATELIER_EMAIL_DRY_RUN=1 なら no-op。

    引数の email / link は本番経路で src.email.sender に渡される。本層は
    抽象化レイヤであり、メール送信が未配線でもユーザー応答 (202) を変更しない。
    """
    if os.environ.get("ATELIER_EMAIL_DRY_RUN") == "1":
        return
    # 未配線時はサイレントに skip (enumeration 防止)。
    _ = email
    _ = link
    return


async def request_magic_link(
    *,
    email: str,
    redirect_url: str | None,
    ip_address: str | None,
) -> None:
    """Magic Link を発行・メール送信する。enumeration を漏らさず常に成功扱い。

    1. opaque token 発行 + sha256 で hash 化
    2. audit_logs に auth.magic_link.issued (token_hash, expires_epoch)
    3. メール送信 (stub)
    """
    plain, token_hash = _new_opaque_token()
    factory = _service_session_factory()
    async with factory() as session:
        try:
            await _emit_token_audit(
                session,
                action="auth.magic_link.issued",
                email=email,
                token_hash=token_hash,
                ttl_minutes=_MAGIC_LINK_TTL_MINUTES,
                ip_address=_normalize_ip(ip_address),
                extra={"redirect_url": redirect_url},
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise
    # メール送信は失敗しても enumeration を防ぐため常に sliently success
    base_url = os.environ.get("ATELIER_PUBLIC_BASE_URL", "https://atelier.example.com")
    link = f"{base_url.rstrip('/')}/auth/magic-link/verify?email={email}&token={plain}"
    with contextlib.suppress(Exception):
        # メール送信が失敗しても enumeration を防ぐため応答に出さない (defense-in-depth)
        await _send_magic_link_email(email=email, link=link)


async def verify_magic_link(
    *,
    email: str,
    token: str,
    ip_address: str | None,
) -> SigninResponse:
    """Magic Link を検証して JWT を発行。

    - 該当 token が無効 / 期限切れ → invalid_token (401)
    - 既に consumed → invalid_token (401)
    - 成功時: auth.magic_link.consumed を記録、JWT + refresh_token 発行
    """
    token_hash = _hash_token(token)
    factory = _service_session_factory()
    async with factory() as session:
        try:
            audit_target = await _find_active_token(
                session,
                action_issued="auth.magic_link.issued",
                action_consumed="auth.magic_link.consumed",
                email=email,
                token_hash=token_hash,
            )
            if audit_target is None:
                raise MagicLinkError("invalid_token", "invalid or expired magic link")

            # user 取得 / soft-deleted は拒否
            res = await session.execute(
                text(
                    "select id, email, display_name, deleted_at from public.users where email = :e"
                ),
                {"e": email},
            )
            row = res.first()
            if row is None or row.deleted_at is not None:
                raise MagicLinkError("invalid_token", "invalid or expired magic link")

            # consumed mark
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.magic_link.consumed",
                    target_type="auth_token",
                    actor_type="user",
                    actor_id=str(row.id),
                    target_id=audit_target,
                    ip_address=_normalize_ip(ip_address),
                    after={"email": email},
                )
            )

            # access + refresh トークン発行
            now_epoch = int(time.time())
            app_meta = await _load_app_metadata(session, user_id=str(row.id))
            token_str, expires_at = _mint_access_token(
                user_id=str(row.id), now=now_epoch, app_metadata=app_meta
            )
            refresh_plain, refresh_hash = _new_opaque_token()
            await _emit_token_audit(
                session,
                action="auth.refresh.issued",
                email=email,
                token_hash=refresh_hash,
                ttl_minutes=_REFRESH_TOKEN_TTL_DAYS * 24 * 60,
                ip_address=_normalize_ip(ip_address),
                extra={"user_id": str(row.id), "origin": "magic_link"},
            )
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.signin",
                    target_type="user",
                    actor_type="user",
                    actor_id=str(row.id),
                    target_id=str(row.id),
                    ip_address=_normalize_ip(ip_address),
                    after={"email": email, "method": "magic_link"},
                )
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise

    return SigninResponse(
        access_token=token_str,
        token_type="bearer",
        expires_at=expires_at,
        user_id=str(row.id),
        email=str(row.email),
        display_name=(None if row.display_name is None else str(row.display_name)),
        refresh_token=refresh_plain,
    )


_OAUTH_AUTHORIZE_URLS = {
    "google": "https://accounts.google.com/o/oauth2/v2/auth",
    "github": "https://github.com/login/oauth/authorize",
}


async def build_oauth_redirect(
    *,
    provider: str,
    ip_address: str | None,
) -> tuple[str, str]:
    """OAuth provider の認可 URL + opaque state を返す。

    state は CSRF 対策で、audit_logs に sha256 hash を残す。callback で
    state が一致しない要求は拒否する (T-A-03 spec: CSRF guard)。
    """
    if provider not in _OAUTH_AUTHORIZE_URLS:
        raise MagicLinkError("unknown_provider", f"unknown provider: {provider}")
    state_plain, state_hash = _new_opaque_token(nbytes=24)
    client_id = os.environ.get(f"ATELIER_OAUTH_{provider.upper()}_CLIENT_ID", "stub")
    redirect_uri = os.environ.get(
        "ATELIER_OAUTH_REDIRECT_URI",
        "https://atelier.example.com/auth/oauth/callback",
    )
    scope = {"google": "email profile openid", "github": "read:user user:email"}[provider]
    authorize_url = (
        f"{_OAUTH_AUTHORIZE_URLS[provider]}"
        f"?client_id={client_id}&redirect_uri={redirect_uri}"
        f"&state={state_plain}&response_type=code&scope={scope.replace(' ', '%20')}"
    )

    factory = _service_session_factory()
    async with factory() as session:
        try:
            await _emit_token_audit(
                session,
                action="auth.oauth.state_issued",
                email=f"oauth:{provider}",
                token_hash=state_hash,
                ttl_minutes=15,
                ip_address=_normalize_ip(ip_address),
                extra={"provider": provider},
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise
    return authorize_url, state_plain


# --------------------------------------------------------------------------- #
# T-A-04: Password Reset + JWT Refresh
# --------------------------------------------------------------------------- #
class PasswordResetError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def request_password_reset(
    *,
    email: str,
    ip_address: str | None,
) -> None:
    """リセット用 token を発行・メール送信。enumeration 防止のため常に成功扱い。"""
    plain, token_hash = _new_opaque_token()
    factory = _service_session_factory()
    async with factory() as session:
        try:
            await _emit_token_audit(
                session,
                action="auth.password_reset.issued",
                email=email,
                token_hash=token_hash,
                ttl_minutes=_PASSWORD_RESET_TTL_MINUTES,
                ip_address=_normalize_ip(ip_address),
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise
    # メール送信は dry-run なら no-op。本番では別経路 (Resend) に置換。
    if os.environ.get("ATELIER_EMAIL_DRY_RUN") == "1":
        return
    _ = plain  # link 内に埋める想定 (本層では送信抽象化)


async def confirm_password_reset(
    *,
    email: str,
    token: str,
    new_password: str,
    ip_address: str | None,
) -> PasswordResetConfirmResponse:
    """token を検証し password を更新する。

    1. issued / consumed audit chain を走査
    2. user 取得 (soft-deleted は拒否)
    3. auth.users.encrypted_password を sha256 で更新 (test/dev)
       本番では Supabase Admin API に PATCH するパスを将来追加
    4. auth.password_reset.consumed + auth.password_changed を記録
    5. 旧 refresh_token を一括失効 (auth.refresh.revoked_all)
    """
    token_hash = _hash_token(token)
    factory = _service_session_factory()
    async with factory() as session:
        try:
            audit_target = await _find_active_token(
                session,
                action_issued="auth.password_reset.issued",
                action_consumed="auth.password_reset.consumed",
                email=email,
                token_hash=token_hash,
            )
            if audit_target is None:
                raise PasswordResetError("invalid_token", "invalid or expired reset token")
            res = await session.execute(
                text(
                    "select u.id, u.email from public.users u "
                    "join auth.users a on a.id = u.id "
                    "where u.email = :e and u.deleted_at is null"
                ),
                {"e": email},
            )
            row = res.first()
            if row is None:
                raise PasswordResetError("invalid_token", "invalid or expired reset token")
            new_hash = hashlib.sha256(new_password.encode("utf-8")).hexdigest()
            # encrypted_password 列が無い test stub では update も列を作る
            await session.execute(
                text("alter table auth.users add column if not exists encrypted_password text")
            )
            await session.execute(
                text("update auth.users set encrypted_password = :p where id = cast(:i as uuid)"),
                {"p": new_hash, "i": str(row.id)},
            )
            now = datetime.now(UTC)
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.password_reset.consumed",
                    target_type="auth_token",
                    actor_type="user",
                    actor_id=str(row.id),
                    target_id=audit_target,
                    ip_address=_normalize_ip(ip_address),
                    after={"email": email},
                )
            )
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.password_changed",
                    target_type="user",
                    actor_type="user",
                    actor_id=str(row.id),
                    target_id=str(row.id),
                    ip_address=_normalize_ip(ip_address),
                    after={"email": email, "changed_at": now.isoformat()},
                )
            )
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.refresh.revoked_all",
                    target_type="user",
                    actor_type="user",
                    actor_id=str(row.id),
                    target_id=str(row.id),
                    ip_address=_normalize_ip(ip_address),
                    after={"reason": "password_changed"},
                )
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise

    return PasswordResetConfirmResponse(
        user_id=str(row.id), email=str(row.email), password_changed_at=now
    )


async def refresh_access_token(
    *,
    refresh_token: str,
    ip_address: str | None,
) -> RefreshResponse:
    """refresh_token を検証して新しい access_token + 新 refresh_token を発行。

    rotate スタイル: 古い token を auth.refresh.consumed で失効 → 新 token を
    auth.refresh.issued で発行。
    """
    token_hash = _hash_token(refresh_token)
    factory = _service_session_factory()
    async with factory() as session:
        try:
            # 直近 / 未消費 / 未失効全体 を満たす refresh token を探す
            now_epoch = int(time.time())
            res = await session.execute(
                text(
                    "select id::text as audit_id, actor_id as email, "
                    "(after->>'user_id') as user_id "
                    "from public.audit_logs "
                    "where action = 'auth.refresh.issued' "
                    "and (after->>'token_hash') = :h "
                    "and (after->>'expires_epoch')::bigint > :now "
                    "and not exists ("
                    "  select 1 from public.audit_logs c "
                    "  where c.action = 'auth.refresh.consumed' "
                    "  and c.target_id::text = public.audit_logs.id::text"
                    ") "
                    "and not exists ("
                    "  select 1 from public.audit_logs r "
                    "  where r.action = 'auth.refresh.revoked_all' "
                    "  and r.actor_id = (after->>'user_id') "
                    "  and r.created_at > public.audit_logs.created_at"
                    ") "
                    "order by created_at desc limit 1"
                ),
                {"h": token_hash, "now": now_epoch},
            )
            row = res.first()
            if row is None:
                raise PasswordResetError("invalid_refresh", "refresh token is invalid or expired")
            user_id = str(row.user_id)
            email = str(row.email)

            # 旧 token を消費
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.refresh.consumed",
                    target_type="auth_token",
                    actor_type="user",
                    actor_id=user_id,
                    target_id=str(row.audit_id),
                    ip_address=_normalize_ip(ip_address),
                    after={"reason": "rotated"},
                )
            )
            # 新 token 発行
            new_plain, new_hash = _new_opaque_token()
            await _emit_token_audit(
                session,
                action="auth.refresh.issued",
                email=email,
                token_hash=new_hash,
                ttl_minutes=_REFRESH_TOKEN_TTL_DAYS * 24 * 60,
                ip_address=_normalize_ip(ip_address),
                extra={"user_id": user_id, "origin": "rotate"},
            )
            app_meta = await _load_app_metadata(session, user_id=user_id)
            access, expires_at = _mint_access_token(
                user_id=user_id, now=now_epoch, app_metadata=app_meta
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise

    return RefreshResponse(
        access_token=access,
        token_type="bearer",
        expires_at=expires_at,
        refresh_token=new_plain,
    )


# --------------------------------------------------------------------------- #
# T-A-05: 退会 (30 日猶予, F-LEGAL-002)
# --------------------------------------------------------------------------- #
class AccountError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def delete_account(
    *,
    user_id: str,
    email: str,
    password: str,
    reason: str | None,
    ip_address: str | None,
) -> tuple[datetime, datetime]:
    """退会受付。soft-delete + 30 日後ハード削除予定を記録する。

    step-up 認証: 現在の password を再確認 (本タスクでは local hash で検証)。
    成功時: public.users.deleted_at = now()、scheduled_purge_at は audit.after
    に記録する (実際のハード削除は worker job が処理する)。
    """
    factory = _service_session_factory()
    async with factory() as session:
        try:
            # password 再確認
            await _verify_password_local(session, email=email, password=password)
            now = datetime.now(UTC)
            purge_at = now + timedelta(days=_ACCOUNT_GRACE_DAYS)
            res = await session.execute(
                text(
                    "update public.users set deleted_at = :d "
                    "where id = cast(:i as uuid) and deleted_at is null "
                    "returning id"
                ),
                {"d": now, "i": user_id},
            )
            if res.scalar_one_or_none() is None:
                raise AccountError("not_found_or_already_deleted", "no active account")
            # 全 refresh_token 失効
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.refresh.revoked_all",
                    target_type="user",
                    actor_type="user",
                    actor_id=user_id,
                    target_id=user_id,
                    ip_address=_normalize_ip(ip_address),
                    after={"reason": "account_deleted"},
                )
            )
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.account.deleted",
                    target_type="user",
                    actor_type="user",
                    actor_id=user_id,
                    target_id=user_id,
                    ip_address=_normalize_ip(ip_address),
                    after={
                        "email": email,
                        "reason": reason,
                        "scheduled_purge_at": purge_at.isoformat(),
                        "deleted_at": now.isoformat(),
                    },
                )
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise
    return now, purge_at


async def restore_account(
    *,
    email: str,
    password: str,
    ip_address: str | None,
) -> tuple[str, datetime]:
    """30 日猶予期間中のアカウント復活。

    deleted_at < now + 30 days のユーザーを復活させる。purge 済 (deleted_at +
    30d 超過) は restore_window_expired として 410 相当を route が返す。
    """
    factory = _service_session_factory()
    async with factory() as session:
        try:
            await _verify_password_local(session, email=email, password=password)
            res = await session.execute(
                text("select id, deleted_at from public.users where email = :e"),
                {"e": email},
            )
            row = res.first()
            if row is None or row.deleted_at is None:
                raise AccountError("no_pending_deletion", "no pending deletion for this account")
            elapsed = datetime.now(UTC) - row.deleted_at.replace(
                tzinfo=row.deleted_at.tzinfo or UTC
            )
            if elapsed.days >= _ACCOUNT_GRACE_DAYS:
                raise AccountError("window_expired", "restore window expired")
            now = datetime.now(UTC)
            await session.execute(
                text("update public.users set deleted_at = null where id = cast(:i as uuid)"),
                {"i": str(row.id)},
            )
            await AuditWriter(session).write(
                AuditEvent(
                    action="auth.account.restored",
                    target_type="user",
                    actor_type="user",
                    actor_id=str(row.id),
                    target_id=str(row.id),
                    ip_address=_normalize_ip(ip_address),
                    after={"email": email, "restored_at": now.isoformat()},
                )
            )
            await session.commit()
        except Exception:
            await session.rollback()
            raise
    return str(row.id), now
