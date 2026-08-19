"""GAP-122: ユーザー別 Bridge 接続トークン — 発行/失効/権限分離の統合テスト。

実 Postgres で:
    - 発行 (raw 1 度だけ) → 一覧 (raw なし) → 失効 (本人のみ・冪等)
    - user トークンは chat-relay (本人の job のみ) + ping で有効
    - user トークンで kanban/pick は 403 (過剰権限の防止)
    - 失効後は 401
"""
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from collections.abc import AsyncGenerator, Iterator
from typing import Annotated

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
BRIDGE_TOKEN = "test-bridge-token-secret"
os.environ["ATELIER_BRIDGE_TOKEN"] = BRIDGE_TOKEN
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402
from src.services import chat_relay  # noqa: E402


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


@pytest.fixture()
def app() -> Iterator[FastAPI]:
    """bridge session / bridge-tokens service session / RLS session を test DB へ。"""
    test_engine = create_async_engine(PG_ASYNC, poolclass=NullPool)

    async def _service_override() -> object:
        async with AsyncSession(test_engine) as session:
            try:
                yield session
            except Exception:
                await session.rollback()
                raise
            else:
                await session.commit()

    async def _rls_override(
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
    from src.routes.bridge_tokens import _service_session
    from src.routes.dispatcher import get_bridge_session

    application = FastAPI()
    application.include_router(api_router)
    application.dependency_overrides[get_bridge_session] = _service_override
    application.dependency_overrides[_service_session] = _service_override
    application.dependency_overrides[get_rls_session] = _rls_override
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws, proj, thread = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for u in (u_a, u_b):
            em = f"bt-{u[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": u, "e": em})
            c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,'bt-ws')"),
            {"i": ws, "o": u_a},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type,status) "
                "values (cast(:i as uuid),cast(:w as uuid),'BtProj','internal_product','active')"
            ),
            {"i": proj, "w": ws},
        )
        emp = c.execute(
            text("select id from public.ai_employees where workspace_id=cast(:w as uuid) limit 1"),
            {"w": ws},
        ).scalar_one()
        c.execute(
            text(
                "insert into public.chat_threads (id,project_id,ai_employee_id,title) "
                "values (cast(:i as uuid),cast(:p as uuid),cast(:e as uuid),'bt-t')"
            ),
            {"i": thread, "p": proj, "e": str(emp)},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws": ws, "proj": proj, "thread": thread}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.chat_relay_jobs where thread_id=cast(:t as uuid)"),
            {"t": thread},
        )
        c.execute(
            text(
                "delete from public.bridge_user_tokens "
                "where user_id in (cast(:a as uuid), cast(:b as uuid))"
            ),
            {"a": u_a, "b": u_b},
        )
        c.execute(text("delete from public.bridge_workers where id like 'bt-%'"))
        c.execute(text("delete from public.chat_threads where id=cast(:i as uuid)"), {"i": thread})
        c.execute(text("delete from public.projects where id=cast(:i as uuid)"), {"i": proj})
        c.execute(text("delete from public.workspaces where id=cast(:i as uuid)"), {"i": ws})
        for u in (u_a, u_b):
            c.execute(text("delete from public.users where id=cast(:i as uuid)"), {"i": u})
            c.execute(text("delete from auth.users where id=cast(:i as uuid)"), {"i": u})


def _enqueue(seeded: dict[str, str], *, requested_by: str) -> str:
    async def _run() -> str:
        eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
        try:
            async with AsyncSession(eng) as s:
                job_id = await chat_relay.enqueue_job(
                    s,
                    thread_id=seeded["thread"],
                    requested_by=requested_by,
                    system_prompt="sys",
                    prompt="prompt",
                )
                await s.commit()
                return job_id
        finally:
            await eng.dispose()

    return asyncio.run(_run())


@pytest.mark.integration
def test_issue_list_revoke_lifecycle(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """発行 (raw 1 度だけ) → 一覧 (raw なし) → 失効 (冪等) の一周。"""
    headers = {"Authorization": f"Bearer {_mint_jwt(seeded['u_a'])}"}
    with TestClient(app) as client:
        assert client.get("/bridge-tokens").status_code == 401

        created = client.post("/bridge-tokens", json={"label": "MacBook"}, headers=headers)
        assert created.status_code == 201
        data = created.json()["data"]
        assert data["label"] == "MacBook"
        raw = data["token"]
        assert len(raw) >= 32

        listed = client.get("/bridge-tokens", headers=headers).json()["data"]
        assert len(listed) == 1
        assert "token" not in listed[0]
        assert listed[0]["revoked_at"] is None

        # DB には hash のみ (raw 非保存)
        with sync_engine.connect() as c:
            th = c.execute(
                text(
                    "select token_hash from public.bridge_user_tokens "
                    "where user_id=cast(:u as uuid)"
                ),
                {"u": seeded["u_a"]},
            ).scalar_one()
            assert th != raw
            assert th == hashlib.sha256(raw.encode()).hexdigest()

        # 他人 (u_b) からは失効できない (404) / 本人は失効できる (冪等)
        headers_b = {"Authorization": f"Bearer {_mint_jwt(seeded['u_b'])}"}
        token_id = data["id"]
        assert (
            client.post(f"/bridge-tokens/{token_id}/revoke", headers=headers_b).status_code == 404
        )
        assert client.post(f"/bridge-tokens/{token_id}/revoke", headers=headers).status_code == 200
        assert client.post(f"/bridge-tokens/{token_id}/revoke", headers=headers).status_code == 200
        listed2 = client.get("/bridge-tokens", headers=headers).json()["data"]
        assert listed2[0]["revoked_at"] is not None


@pytest.mark.integration
def test_user_token_scope_and_revocation(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """user トークン: 本人 job のみ pick / kanban 403 / ping で user_id 記録 / 失効後 401。"""
    headers_a = {"Authorization": f"Bearer {_mint_jwt(seeded['u_a'])}"}
    with TestClient(app) as client:
        raw = client.post("/bridge-tokens", json={}, headers=headers_a).json()["data"]["token"]
        user_hdr = {"X-Bridge-Token": raw}

        # kanban 系は 403 (チャット接続専用)
        assert (
            client.post("/kanban/pick", json={"worker_pid": 1}, headers=user_hdr).status_code == 403
        )

        # 他人 (u_b) の job しか無い → 本人 job なし = no_available_job
        job_b = _enqueue(seeded, requested_by=seeded["u_b"])
        r1 = client.post("/chat-relay/pick", json={"worker_id": "bt-w1"}, headers=user_hdr)
        assert r1.status_code == 200
        assert r1.json()["data"]["no_available_job"] is True

        # 本人 job を積むと pick できる (u_b の job は残る)
        job_a = _enqueue(seeded, requested_by=seeded["u_a"])
        r2 = client.post("/chat-relay/pick", json={"worker_id": "bt-w1"}, headers=user_hdr)
        assert r2.json()["data"]["job_id"] == job_a

        # インスタンス トークンは従来どおり無差別に pick できる (u_b の job)
        inst_hdr = {"X-Bridge-Token": BRIDGE_TOKEN}
        r3 = client.post("/chat-relay/pick", json={"worker_id": "bt-w2"}, headers=inst_hdr)
        assert r3.json()["data"]["job_id"] == job_b

        # ping は user_id を記録する
        ping = client.post(
            "/bridge/ping",
            json={"worker_id": "bt-w1", "host_label": "my-pc", "version": "1.0.0"},
            headers=user_hdr,
        )
        assert ping.status_code == 200
        with sync_engine.connect() as c:
            uid = c.execute(
                text("select user_id from public.bridge_workers where id='bt-w1'")
            ).scalar_one()
            assert str(uid) == seeded["u_a"]

        # 失効後は 401
        token_id = client.get("/bridge-tokens", headers=headers_a).json()["data"][0]["id"]
        client.post(f"/bridge-tokens/{token_id}/revoke", headers=headers_a)
        r4 = client.post("/chat-relay/pick", json={"worker_id": "bt-w1"}, headers=user_hdr)
        assert r4.status_code == 401


@pytest.mark.integration
def test_user_token_works_without_instance_token(
    app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """GAP-169: 運営が ATELIER_BRIDGE_TOKEN を入れていなくても本人トークンで繋がる。

    以前は環境変数未設定を 500 で弾いていたため、画面の接続フロー (GAP-122) で
    トークンを発行しても Bridge が「bridge auth failed: 500」で繋がらなかった。
    インスタンス トークンは kanban / タスク実行系のための任意設定であり、
    本人の PC を繋ぐのに必須ではない。
    """
    headers_a = {"Authorization": f"Bearer {_mint_jwt(seeded['u_a'])}"}
    with TestClient(app) as client:
        raw = client.post("/bridge-tokens", json={}, headers=headers_a).json()["data"]["token"]
        monkeypatch.delenv("ATELIER_BRIDGE_TOKEN", raising=False)

        # 本人トークン: 500 ではなく通る
        r = client.post(
            "/chat-relay/pick", json={"worker_id": "gap169-w"}, headers={"X-Bridge-Token": raw}
        )
        assert r.status_code == 200, r.text
        assert r.json()["data"]["no_available_job"] is True

        # 未知トークンは 500 ではなく 401 (誤設定と誤認証を混同しない)
        bad = client.post(
            "/chat-relay/pick",
            json={"worker_id": "gap169-w"},
            headers={"X-Bridge-Token": "not-a-real-token"},
        )
        assert bad.status_code == 401

        # ヘッダー無しも 401
        none = client.post("/chat-relay/pick", json={"worker_id": "gap169-w"})
        assert none.status_code == 401
