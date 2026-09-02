"""FastAPI 共有依存 (T-A-06)。

保護エンドポイント横断で使う:
  - get_current_user: Supabase JWT (HS256) をローカル検証し user_id を返す。
    署名検証は SUPABASE_JWT_SECRET で行い、Supabase Auth サービスへの往復は不要。
  - get_rls_session: RLS が効く AsyncSession を払い出す。接続単位で
    `set local role authenticated` + `request.jwt.claims` を投入し、
    per-entity RLS policy (T-D-14〜) を DB 側で enforce する。

外部 Supabase Auth に依存する signup/signin (T-A-01/02) とは独立しており、
本依存は JWT 検証のみで完結する (ローカル検証可能)。
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import logging
import time
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass
from functools import lru_cache
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import event, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.auth_messages import (
    AUTH_NOT_CONFIGURED,
    SIGNIN_REQUIRED,
    TOKEN_REJECTED,
    log_token_rejection,
)
from src.db.session import shared_session_factory
from src.txn_commit import current_rls_session

logger = logging.getLogger(__name__)

#: GAP-245: 「退会していない」と確認した結果を覚えておく秒数。
#: 毎リクエストの DB 往復を避けつつ、退会後に既存セッションが生き残る窓を
#: この秒数以内に抑える (同一プロセスでは退会時に即座に捨てるので 0 秒)。
ACTIVE_USER_CACHE_SECONDS = 30.0
_active_user_checked_at: dict[str, float] = {}


def forget_active_user(user_id: str) -> None:
    """GAP-245: 退会/復活のときに呼ぶ — 次のリクエストで必ず DB を見直す。"""
    _active_user_checked_at.pop(user_id, None)


async def ensure_account_active(user_id: str) -> None:
    """GAP-245: 退会 (soft delete) 済みの利用者は、期限内の JWT でも通さない。

    本番実測: 退会 (200) 後も同じ JWT で GET /workspaces が 200・チャット実行まで
    通っていた。signin は 401 (存在秘匿) なのに、**発行済みのセッションだけが
    退会後も生き残る** (盗まれたトークンも退会で切れない)。JWT はサーバー側に
    状態を持たないので、ここで public.users.deleted_at を見る。

    DB に届かないときは判定しない (後段の DB 操作がどのみち失敗する。ここで
    落とすと DB 不要の経路まで巻き添えになる)。
    """
    try:
        uuid.UUID(user_id)
    except ValueError:
        return  # public.users に居ない形の sub (テスト用等) は対象外
    now = time.monotonic()
    checked = _active_user_checked_at.get(user_id)
    if checked is not None and now - checked < ACTIVE_USER_CACHE_SECONDS:
        return
    try:
        factory = shared_session_factory()
        async with factory() as session:
            row = (
                await session.execute(
                    text("select deleted_at from public.users where id = cast(:i as uuid)"),
                    {"i": user_id},
                )
            ).first()
    except Exception:
        logger.warning("退会済み判定を行えませんでした (DB 不達)", exc_info=True)
        return
    if row is not None and row.deleted_at is not None:
        forget_active_user(user_id)
        log_token_rejection("account deleted")
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            SIGNIN_REQUIRED,
            headers={"WWW-Authenticate": "Bearer"},
        )
    _active_user_checked_at[user_id] = now


class AuthSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ATELIER_AUTH_", env_file=".env", extra="ignore")
    jwt_secret: str = Field(
        default="",
        description="Supabase JWT 署名検証用 secret (HS256)。ATELIER_AUTH_JWT_SECRET",
    )


@lru_cache(maxsize=1)
def _auth_settings() -> AuthSettings:
    return AuthSettings()


@dataclass(frozen=True)
class CurrentUser:
    """検証済み JWT が表す認証ユーザー。"""

    id: str
    role: str
    claims: dict[str, object]


def _b64url_decode(segment: str) -> bytes:
    padding = "=" * (-len(segment) % 4)
    return base64.urlsafe_b64decode(segment + padding)


def decode_supabase_jwt(token: str, secret: str, *, now: int | None = None) -> CurrentUser:
    """Supabase 形式 JWT (HS256) を検証して CurrentUser を返す。

    Raises:
        HTTPException(401): 形式不正 / 署名不一致 / 期限切れ / sub 欠落。
    """
    parts = token.split(".")
    if len(parts) != 3:
        log_token_rejection("malformed token")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, TOKEN_REJECTED)
    header_b64, payload_b64, sig_b64 = parts

    signing_input = f"{header_b64}.{payload_b64}".encode("ascii")
    expected = hmac.new(secret.encode("utf-8"), signing_input, hashlib.sha256).digest()
    try:
        provided = _b64url_decode(sig_b64)
    except (binascii.Error, ValueError) as exc:
        log_token_rejection("malformed signature")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, TOKEN_REJECTED) from exc
    if not hmac.compare_digest(expected, provided):
        log_token_rejection("invalid signature")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, TOKEN_REJECTED)

    try:
        payload: dict[str, object] = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError) as exc:
        log_token_rejection("malformed payload")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, TOKEN_REJECTED) from exc

    exp = payload.get("exp")
    current = int(time.time()) if now is None else now
    if isinstance(exp, int) and current >= exp:
        log_token_rejection("expired")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, TOKEN_REJECTED)

    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub:
        log_token_rejection("missing sub")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, TOKEN_REJECTED)
    role = payload.get("role")
    # R-T08: client_portal JWT (sub="client:<invitation_id>") は同一 secret で署名
    # されるため署名検証を通過してしまう。staff 経路では明示拒否しないと、後段の
    # uuid cast で 500 になる (design-audit S-L03 で検出した実バグ)。
    if role == "client_portal" or sub.startswith("client:"):
        log_token_rejection("client portal token on staff route")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, TOKEN_REJECTED)
    return CurrentUser(
        id=sub,
        role=role if isinstance(role, str) else "authenticated",
        claims=payload,
    )


async def get_current_user(
    authorization: str | None = Header(default=None),
) -> CurrentUser:
    """Authorization: Bearer <jwt> を検証して CurrentUser を返す FastAPI 依存。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            SIGNIN_REQUIRED,
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = authorization[len("bearer ") :].strip()
    secret = _auth_settings().jwt_secret
    if not secret:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, AUTH_NOT_CONFIGURED)
    user = decode_supabase_jwt(token, secret)
    # GAP-245: 署名・期限が正しくても、退会済みなら通さない
    await ensure_account_active(user.id)
    return user


def _session_factory() -> async_sessionmaker[AsyncSession]:
    """GAP-197: RLS セッションも共有 engine を使う。

    以前はここが独立した engine を持っていたため、service 系 12 個と合わせて
    **プロセス内に 13 engine (最大 195 接続/machine)** になっていた。
    role / claims は `set local` (transaction-local) なので、同じプールを
    service セッションと共有しても設定は次の transaction へ漏れない。
    """
    return shared_session_factory()


def _install_rls_guard(session: AsyncSession, claims: str) -> None:
    """**トランザクションが始まるたびに** role と claims を貼り直す。

    GAP-201: role / claims は `set local` = **transaction-local** なので、
    途中で commit するとその瞬間に消える。以前は払い出し時に 1 回だけ入れて
    いたため、リクエストの途中で commit したあとに実行される SQL は
    **RLS が効かない状態 (接続ロールのまま) で走っていた**。

    ここで `after_begin` に紐付けておけば、commit のたびに自動で貼り直る。
    副産物として「待っている間だけ DB 接続を手放す」(SSE) が安全にできる。
    """

    def _apply(_sync_session: object, _transaction: object, connection: Connection) -> None:
        # claims を先に設定 (権限のあるうちに) してから role を下げる。
        connection.execute(
            text("select set_config('request.jwt.claims', :claims, true)"),
            {"claims": claims},
        )
        connection.execute(text("set local role authenticated"))

    event.listen(session.sync_session, "after_begin", _apply)


async def get_rls_session(
    user: Annotated[CurrentUser, Depends(get_current_user)],
) -> AsyncGenerator[AsyncSession, None]:
    """RLS が効く AsyncSession を払い出す。

    接続単位で role=authenticated + request.jwt.claims を投入し、per-entity RLS が
    auth.uid() = user.id として評価されるようにする。例外時 rollback、正常時 commit。

    GAP-201: 投入は `after_begin` フックで行うので、**リクエストの途中で
    commit しても RLS は効いたまま**になる (以前は消えていた)。
    """
    factory = _session_factory()
    claims = json.dumps({"sub": user.id, "role": user.role})
    async with factory() as session:
        _install_rls_guard(session, claims)
        # CommitBeforeResponseMiddleware がレスポンス送信「前」に commit できるよう
        # 現リクエストのセッションを contextvar へ登録する (read-your-own-write 整合)。
        token = current_rls_session.set(session)
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            # 通常応答は middleware が commit 済み (ここは空 txn で無害)。
            # SSE 等の除外経路はここが実 commit になる。
            await session.commit()
        finally:
            current_rls_session.reset(token)
