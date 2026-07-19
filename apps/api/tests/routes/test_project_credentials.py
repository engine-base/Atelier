"""プロジェクト・シークレット (T-A-46) のユニットテスト。

暗号化往復・last4 マスク・スキーマの平文非含有を検証する。実 Postgres を
要する RLS 越境試験は tests/rls/t-d-36_vault.py が担当する。
"""

from __future__ import annotations

import os

import pytest
from cryptography.fernet import Fernet

# サービス層が import 時に env を読まないよう、先に鍵を用意する。
os.environ.setdefault("ATELIER_VAULT_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))

from src.schemas.project_credentials import (
    CredentialResponse,
    CredentialReveal,
)
from src.services import project_credentials as svc


def test_encrypt_decrypt_roundtrip() -> None:
    """暗号化 → 復号で元の平文に戻り、ciphertext は平文と異なる。"""
    plain = "ghp_SuperSecret_0123456789"
    ct = svc.encrypt_value(plain)
    assert ct != plain
    assert not ct.startswith("ghp_")  # 平文が露出していない
    assert svc.decrypt_value(ct) == plain


def test_last4_helper() -> None:
    last4 = svc._last4  # pyright: ignore[reportPrivateUsage]
    assert last4("abcdefgh") == "efgh"
    assert last4("ab") == "ab"  # 4 文字未満はそのまま


def test_response_schema_has_no_plaintext() -> None:
    """一覧/詳細応答スキーマに plaintext/encrypted フィールドが無い。"""
    fields = set(CredentialResponse.model_fields.keys())
    assert "value" not in fields
    assert "encrypted_value" not in fields
    # マスク用の last4 とメタ情報のみ
    assert {"id", "project_id", "name", "kind", "last4"}.issubset(fields)


def test_reveal_schema_returns_value() -> None:
    """reveal 応答のみ plaintext value を持つ。"""
    assert "value" in CredentialReveal.model_fields


def test_missing_key_raises() -> None:
    """暗号鍵が未設定なら 500 を投げる (鍵キャッシュをクリアして検証)。"""
    svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]
    saved = os.environ.pop("ATELIER_VAULT_ENCRYPTION_KEY", None)
    try:
        with pytest.raises(Exception):  # noqa: B017 - HTTPException(500)
            svc.encrypt_value("x")
    finally:
        if saved is not None:
            os.environ["ATELIER_VAULT_ENCRYPTION_KEY"] = saved
        svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]


# ---------------------------------------------------------------------------
# 統合テスト (実 Postgres): created_by_name の契約拡張 (S-B04 design-audit v2)
# ---------------------------------------------------------------------------

import asyncio  # noqa: E402
import base64  # noqa: E402
import hashlib  # noqa: E402
import hmac  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
import uuid  # noqa: E402
from collections.abc import AsyncGenerator, Iterator  # noqa: E402
from typing import Annotated  # noqa: E402

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)


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


@pytest.fixture()
def cred_app() -> Iterator[FastAPI]:
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


@pytest.mark.skipif(not _db_available(), reason="local Postgres not available")
def test_created_by_name_in_list(cred_app: FastAPI) -> None:
    """S-B04: 一覧応答に作成者の display_name が載る (users join)。"""
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    uid, ws, pid = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    em = f"cred-{uid[:8]}@t.invalid"
    with eng.begin() as c:
        c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
        c.execute(
            text("insert into public.users (id,email,display_name) values (:i,:e,'監査 作成者')"),
            {"i": uid, "e": em},
        )
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,'credws')"),
            {"i": ws, "o": uid},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,'credproj','personal')"
            ),
            {"i": pid, "w": ws},
        )
    try:
        h = {"Authorization": f"Bearer {_mint_jwt(uid)}"}
        with TestClient(cred_app) as client:
            r = client.post(
                f"/projects/{pid}/credentials",
                json={"name": "監査トークン", "kind": "token", "value": "secret-value-1a2b"},
                headers=h,
            )
            assert r.status_code == 201, r.text
            body = r.json()["data"]
            assert body["created_by_name"] == "監査 作成者"
            assert body["last4"] == "1a2b"
            listed = client.get(f"/projects/{pid}/credentials", headers=h).json()["data"]
            assert listed[0]["created_by_name"] == "監査 作成者"
            assert "value" not in listed[0] and "encrypted_value" not in listed[0]
    finally:
        with eng.begin() as c:
            c.execute(text("delete from public.workspaces where id = :i"), {"i": ws})
            c.execute(text("delete from public.users where id = :i"), {"i": uid})
            c.execute(text("delete from auth.users where id = :i"), {"i": uid})
        eng.dispose()
