"""Integration tests for /chat/threads/{id}/stream (T-A-18) — 実 Postgres + RLS + JWT。

F-CTX01 文脈構築 + LLM 応答 SSE 配信。ANTHROPIC_API_KEY 未設定環境では
service が fake stream にフォールバックするため、SSE 配信パス + DB persist +
audit を deterministic に検証できる。
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
from collections.abc import AsyncGenerator, Iterator
from typing import Annotated

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)
# 実 Anthropic / Voyage 呼出を避けて deterministic fallback path を通す
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("VOYAGE_API_KEY", None)
# T-A-48: 本番は LLM 未接続時 fake を返さないが、テストでは echo fallback を許可する
os.environ["ATELIER_ALLOW_FAKE_LLM"] = "1"

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402


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


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")


@pytest.fixture()
def app() -> Iterator[FastAPI]:
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


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a = str(uuid.uuid4())
    emp_a = str(uuid.uuid4())
    thread_a = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta18-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
        # ai_employee (chat_threads.ai_employee_id 必須)
        c.execute(
            text(
                "insert into public.ai_employees "
                "(id, workspace_id, name, display_name, role, department) "
                "values (cast(:i as uuid), cast(:w as uuid), :n, :d, "
                "'member', 'dev_qa')"
            ),
            {"i": emp_a, "w": ws_a, "n": f"emp-{emp_a[:6]}", "d": "Test Employee"},
        )
        c.execute(
            text(
                "insert into public.chat_threads "
                "(id, project_id, ai_employee_id, title) "
                "values (cast(:i as uuid), cast(:p as uuid), cast(:e as uuid), :t)"
            ),
            {"i": thread_a, "p": proj_a, "e": emp_a, "t": "thread-a"},
        )
        # 既存履歴 1 件 (assistant 過去応答)
        c.execute(
            text(
                "insert into public.chat_messages (id, thread_id, role, content) "
                "values (cast(:i as uuid), cast(:t as uuid), 'assistant', "
                "'前回の応答')"
            ),
            {"i": str(uuid.uuid4()), "t": thread_a},
        )
    yield {
        "u_a": u_a,
        "u_b": u_b,
        "ws_a": ws_a,
        "proj_a": proj_a,
        "thread_a": thread_a,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


def _parse_sse(body: bytes) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for raw in body.split(b"\n\n"):
        line = raw.strip()
        if not line.startswith(b"data:"):
            continue
        events.append(json.loads(line[5:].strip()))
    return events


@pytest.mark.integration
class TestChatSSE:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            tid = uuid.uuid4()
            assert (
                client.post(
                    f"/chat/threads/{tid}/stream",
                    json={"user_message": "hi"},
                ).status_code
                == 401
            )
            assert (
                client.post(
                    f"/chat/threads/{tid}/context-preview",
                    json={"user_message": "hi"},
                ).status_code
                == 401
            )

    def test_stream_404_for_nonexistent_thread(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.post(
                    f"/chat/threads/{uuid.uuid4()}/stream",
                    headers=h,
                    json={"user_message": "hi"},
                ).status_code
                == 404
            )

    def test_stream_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=hb,
                json={"user_message": "hi"},
            )
            assert r.status_code == 404

    def test_stream_persists_user_and_assistant_messages(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=h,
                json={
                    "user_message": "hello world",
                    "use_knowledge_rag": False,
                    "include_history": 5,
                },
            )
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            events = _parse_sse(r.content)
        types = [e["type"] for e in events]
        assert "context" in types
        assert "start" in types
        assert "end" in types
        assert types.count("delta") >= 1
        # fake stream は "echo: hello world" を 1 文字ずつ delta
        joined = "".join(str(e.get("content", "")) for e in events if e["type"] == "delta")
        assert "echo: hello world" in joined
        # DB persist + audit_logs を sync engine で確認
        with sync_engine.begin() as c:
            cnt_user = c.execute(
                text(
                    "select count(*) from public.chat_messages "
                    "where thread_id = cast(:t as uuid) and role = 'user' "
                    "and content = 'hello world'"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
            assert cnt_user == 1
            cnt_assistant = c.execute(
                text(
                    "select count(*) from public.chat_messages "
                    "where thread_id = cast(:t as uuid) and role = 'assistant' "
                    "and content like 'echo:%'"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
            assert cnt_assistant == 1
            audit_cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'chat.message.create' "
                    "and (after->>'thread_id') = :t"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
            # user 1 + assistant 1
            assert audit_cnt >= 2

    def test_stream_context_includes_history_count(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=h,
                json={
                    "user_message": "follow up",
                    "use_knowledge_rag": False,
                    "include_history": 10,
                },
            )
            events = _parse_sse(r.content)
        ctx_evt = next(e for e in events if e["type"] == "context")
        meta = ctx_evt["metadata"]
        assert isinstance(meta, dict)
        # 既存 history 1 件 (seeded fixture で挿入)
        assert int(str(meta["history_count"])) >= 1
        assert isinstance(meta["rag_hit_ids"], list)

    def test_context_preview_does_not_persist(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with sync_engine.begin() as c:
            before = c.execute(
                text(
                    "select count(*) from public.chat_messages where thread_id = cast(:t as uuid)"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/context-preview",
                headers=h,
                json={"user_message": "preview only", "include_history": 5},
            )
            assert r.status_code == 200
            data = r.json()["data"]
            assert "system_prompt" in data
            assert "Atelier" in data["system_prompt"]
            assert isinstance(data["rag_hit_ids"], list)
        # 副作用なし
        with sync_engine.begin() as c:
            after = c.execute(
                text(
                    "select count(*) from public.chat_messages where thread_id = cast(:t as uuid)"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
            assert before == after

    def test_stream_rejects_empty_user_message_422(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=h,
                json={"user_message": ""},
            )
            assert r.status_code == 422

    def test_stream_rejects_oversize_history_422(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=h,
                json={"user_message": "x", "include_history": 1000},
            )
            assert r.status_code == 422
