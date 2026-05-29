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

import hashlib
import ipaddress
import os
import secrets
import uuid
from functools import lru_cache
from typing import Any

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.db.session import create_engine, create_session_factory
from src.schemas.auth import ConsentEntry, SignupRequest, SignupResponse


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


@lru_cache(maxsize=1)
def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    """service_role 相当の sessionmaker。RLS バイパス用 (role を下げない)。"""
    return create_session_factory(create_engine())


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
    uid = body.get("id") if isinstance(body, dict) else None
    if not isinstance(uid, str):
        raise SignupError("supabase_admin_error", "missing id from Supabase response")
    return uid


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
    # password は受け取るが本層では未使用 (Supabase Admin API path で使う)
    _ = hashlib.sha256(password.encode("utf-8")).hexdigest()
    await session.execute(
        text("insert into auth.users (id, email) values (cast(:i as uuid), :e)"),
        {"i": new_id, "e": email},
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
    async with factory() as session:
        try:
            uid = await _create_supabase_auth_user(email=str(data.email), password=data.password)
            if uid is None:
                uid = await _create_local_auth_user(
                    session, email=str(data.email), password=data.password
                )
            else:
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
        except Exception:
            await session.rollback()
            raise

    return SignupResponse(
        user_id=str(row.id),
        email=str(row.email),
        display_name=str(row.display_name),
        consents_recorded=len(data.consents),
        created_at=row.created_at,
    )


# unused import shim — secrets is reserved for token issuance in T-A-02/03 path
_ = secrets
