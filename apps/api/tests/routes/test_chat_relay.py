"""GAP-114: チャットのローカル実行リレー — routes + service + SSE 中継の統合テスト。

実 Postgres + X-Bridge-Token で、enqueue → pick → chunks → complete の
一周と、SSE 側アダプタ (relay_stream_chunks) の中継・誠実エラー・RLS を検証する。
"""
# pyright: reportUnknownMemberType=false

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterator

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
BRIDGE_TOKEN = "test-bridge-token-secret"
os.environ["ATELIER_BRIDGE_TOKEN"] = BRIDGE_TOKEN
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

import sqlalchemy  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.services import chat_relay  # noqa: E402
from src.services.chat_sse import relay as sse_relay  # noqa: E402


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

    async def _override() -> object:
        async with AsyncSession(test_engine) as session:
            try:
                yield session
            except Exception:
                await session.rollback()
                raise
            else:
                await session.commit()

    from src.routes import api_router
    from src.routes.dispatcher import get_bridge_session

    application = FastAPI()
    application.include_router(api_router)
    application.dependency_overrides[get_bridge_session] = _override
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_a = str(uuid.uuid4())
    u_b = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    thread = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for u in (u_a, u_b):
            em = f"relay-{u[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": u, "e": em})
            c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,'relay-ws')"),
            {"i": ws, "o": u_a},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type,status) "
                "values (cast(:i as uuid),cast(:w as uuid),'RelayProj','internal_product','active')"
            ),
            {"i": proj, "w": ws},
        )
        # WS 作成トリガ (t-d-99) が自動シードした AI 社員を thread に紐付ける
        emp = c.execute(
            text("select id from public.ai_employees where workspace_id=cast(:w as uuid) limit 1"),
            {"w": ws},
        ).scalar_one()
        c.execute(
            text(
                "insert into public.chat_threads (id,project_id,ai_employee_id,title) "
                "values (cast(:i as uuid),cast(:p as uuid),cast(:e as uuid),'relay-t')"
            ),
            {"i": thread, "p": proj, "e": str(emp)},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws": ws, "proj": proj, "thread": thread}
    with sync_engine.begin() as c:
        c.execute(
            text(
                "delete from public.chat_relay_jobs where thread_id=cast(:t as uuid)"
            ),  # chunks は FK cascade
            {"t": thread},
        )
        c.execute(text("delete from public.chat_threads where id=cast(:i as uuid)"), {"i": thread})
        c.execute(text("delete from public.projects where id=cast(:i as uuid)"), {"i": proj})
        c.execute(text("delete from public.workspaces where id=cast(:i as uuid)"), {"i": ws})
        for u in (u_a, u_b):
            c.execute(text("delete from public.users where id=cast(:i as uuid)"), {"i": u})
            c.execute(text("delete from auth.users where id=cast(:i as uuid)"), {"i": u})


def _enqueue(seeded: dict[str, str]) -> str:
    async def _run() -> str:
        eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
        try:
            async with AsyncSession(eng) as s:
                job_id = await chat_relay.enqueue_job(
                    s,
                    thread_id=seeded["thread"],
                    requested_by=seeded["u_a"],
                    system_prompt="sys-prompt",
                    prompt="user-prompt",
                )
                await s.commit()
                return job_id
        finally:
            await eng.dispose()

    return asyncio.run(_run())


HEADERS = {"X-Bridge-Token": BRIDGE_TOKEN}


@pytest.mark.integration
def test_pick_requires_token(app: FastAPI) -> None:
    with TestClient(app) as client:
        res = client.post("/chat-relay/pick", json={"worker_id": "w1"})
        assert res.status_code == 401


@pytest.mark.integration
def test_pick_empty_queue(app: FastAPI) -> None:
    with TestClient(app) as client:
        res = client.post("/chat-relay/pick", json={"worker_id": "w1"}, headers=HEADERS)
        assert res.status_code == 200
        assert res.json()["data"]["no_available_job"] is True


@pytest.mark.integration
def test_roundtrip_pick_chunks_complete(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """enqueue → pick → chunks×2 → complete(done) の一周を HTTP 経由で検証。"""
    job_id = _enqueue(seeded)
    with TestClient(app) as client:
        picked = client.post("/chat-relay/pick", json={"worker_id": "w1"}, headers=HEADERS)
        assert picked.status_code == 200
        data = picked.json()["data"]
        assert data["job_id"] == job_id
        assert data["system_prompt"] == "sys-prompt"
        assert data["prompt"] == "user-prompt"

        r1 = client.post(
            f"/chat-relay/{job_id}/chunks",
            json={"seq_start": 0, "texts": ["こん", "にちは"]},
            headers=HEADERS,
        )
        assert r1.status_code == 200
        r2 = client.post(
            f"/chat-relay/{job_id}/chunks",
            json={"seq_start": 2, "texts": ["!"]},
            headers=HEADERS,
        )
        assert r2.status_code == 200
        done = client.post(f"/chat-relay/{job_id}/complete", json={"ok": True}, headers=HEADERS)
        assert done.status_code == 200

    with sync_engine.connect() as c:
        status = c.execute(
            text("select status from public.chat_relay_jobs where id=cast(:i as uuid)"),
            {"i": job_id},
        ).scalar_one()
        assert status == "done"
        contents = [
            str(r.content)
            for r in c.execute(
                text(
                    "select content from public.chat_relay_chunks "
                    "where job_id=cast(:i as uuid) order by seq"
                ),
                {"i": job_id},
            )
        ]
        assert contents == ["こん", "にちは", "!"]
        audit_actions = {
            str(r.action)
            for r in c.execute(
                text(
                    "select action from public.audit_logs "
                    "where target_type='chat_relay_job' and target_id=:i"
                ),
                {"i": job_id},
            )
        }
        assert {"chat_relay.enqueue", "chat_relay.pick", "chat_relay.complete"} <= audit_actions


@pytest.mark.integration
def test_chunks_state_guards(app: FastAPI, seeded: dict[str, str]) -> None:
    """queued への chunks は 409、complete 済への chunks も 409、不在/不正 id は 404。"""
    job_id = _enqueue(seeded)
    with TestClient(app) as client:
        # queued のまま (pick 前) の追記は invalid_state
        r0 = client.post(
            f"/chat-relay/{job_id}/chunks",
            json={"seq_start": 0, "texts": ["x"]},
            headers=HEADERS,
        )
        assert r0.status_code == 409
        client.post("/chat-relay/pick", json={"worker_id": "w1"}, headers=HEADERS)
        client.post(f"/chat-relay/{job_id}/complete", json={"ok": True}, headers=HEADERS)
        r1 = client.post(
            f"/chat-relay/{job_id}/chunks",
            json={"seq_start": 0, "texts": ["x"]},
            headers=HEADERS,
        )
        assert r1.status_code == 409
        r2 = client.post(
            f"/chat-relay/{uuid.uuid4()}/chunks",
            json={"seq_start": 0, "texts": ["x"]},
            headers=HEADERS,
        )
        assert r2.status_code == 404
        r3 = client.post(
            "/chat-relay/not-a-uuid/chunks",
            json={"seq_start": 0, "texts": ["x"]},
            headers=HEADERS,
        )
        assert r3.status_code == 404
        # 二重 complete は 409
        r4 = client.post(f"/chat-relay/{job_id}/complete", json={"ok": True}, headers=HEADERS)
        assert r4.status_code == 409


@pytest.mark.integration
def test_rls_only_requester_can_select(
    seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """R-T08: chat_relay_jobs/chunks は requested_by 本人のみ SELECT 可。"""
    job_id = _enqueue(seeded)

    def _visible_count(user_id: str, table: str, where: str) -> int:
        with sync_engine.connect() as c:
            c.execute(text("begin"))
            c.execute(text("set local role authenticated"))
            c.execute(
                text("select set_config('request.jwt.claims', :c, true)"),
                {"c": f'{{"sub":"{user_id}","role":"authenticated"}}'},
            )
            n = c.execute(
                text(f"select count(*) from {table} where {where}"),
                {"i": job_id},
            ).scalar_one()
            c.execute(text("rollback"))
            return int(n)

    jobs_where = "id=cast(:i as uuid)"
    chunks_where = "job_id=cast(:i as uuid)"
    assert _visible_count(seeded["u_a"], "public.chat_relay_jobs", jobs_where) == 1
    assert _visible_count(seeded["u_b"], "public.chat_relay_jobs", jobs_where) == 0
    with sync_engine.begin() as c:
        c.execute(
            text("update public.chat_relay_jobs set status='running' where id=cast(:i as uuid)"),
            {"i": job_id},
        )
        c.execute(
            text(
                "insert into public.chat_relay_chunks (job_id,seq,content) "
                "values (cast(:i as uuid),0,'x')"
            ),
            {"i": job_id},
        )
    assert _visible_count(seeded["u_a"], "public.chat_relay_chunks", chunks_where) == 1
    assert _visible_count(seeded["u_b"], "public.chat_relay_chunks", chunks_where) == 0


# ─────────────────────────────────────────────────────────
# SSE 側アダプタ (relay_stream_chunks)
# ─────────────────────────────────────────────────────────


@pytest.fixture()
def relay_test_factory(monkeypatch: pytest.MonkeyPatch) -> Iterator[object]:
    """sse_relay の session factory をテスト DB に差し替える。"""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(sse_relay, "_session_factory", lambda: factory)
    yield factory
    asyncio.run(engine.dispose())


def _ping_worker(sync_engine: sqlalchemy.Engine, worker_id: str = "relay-test#1") -> None:
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.bridge_workers (id,host_label,version,last_seen_at) "
                "values (:i,'test','0.0.0',now()) "
                "on conflict (id) do update set last_seen_at=now()"
            ),
            {"i": worker_id},
        )


def _clear_workers(sync_engine: sqlalchemy.Engine) -> None:
    with sync_engine.begin() as c:
        c.execute(text("update public.bridge_workers set last_seen_at = now() - interval '1 hour'"))


@pytest.mark.integration
def test_relay_stream_offline_is_honest(
    seeded: dict[str, str],
    sync_engine: sqlalchemy.Engine,
    relay_test_factory: object,
) -> None:
    """worker presence 鮮度切れなら enqueue せず RelayUnavailable。"""
    _clear_workers(sync_engine)

    async def _run() -> None:
        gen = sse_relay.relay_stream_chunks(
            system_prompt="s",
            history=[],
            user_message="u",
            thread_id=seeded["thread"],
            actor_id=seeded["u_a"],
        )
        with pytest.raises(sse_relay.RelayUnavailable):
            await gen.__anext__()

    asyncio.run(_run())
    with sync_engine.connect() as c:
        n = c.execute(
            text("select count(*) from public.chat_relay_jobs where thread_id=cast(:t as uuid)"),
            {"t": seeded["thread"]},
        ).scalar_one()
        assert int(n) == 0


@pytest.mark.integration
def test_relay_stream_end_to_end_with_fake_worker(
    seeded: dict[str, str],
    sync_engine: sqlalchemy.Engine,
    relay_test_factory: object,
) -> None:
    """SSE 中継: fake worker が pick→chunks→complete し、delta が順に届く。"""
    _ping_worker(sync_engine)

    async def _fake_worker() -> None:
        eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
        try:
            picked = None
            for _ in range(80):  # 最大 ~4s 待つ
                async with AsyncSession(eng) as s:
                    picked = await chat_relay.pick_job(s, worker_id="relay-test#1")
                    await s.commit()
                if picked is not None:
                    break
                await asyncio.sleep(0.05)
            assert picked is not None, "fake worker が job を pick できなかった"
            async with AsyncSession(eng) as s:
                await chat_relay.append_chunks(
                    s, job_id=picked["job_id"], seq_start=0, texts=["やあ、", "こんにちは"]
                )
                await s.commit()
            async with AsyncSession(eng) as s:
                await chat_relay.append_chunks(s, job_id=picked["job_id"], seq_start=2, texts=["!"])
                await chat_relay.complete_job(s, job_id=picked["job_id"], ok=True)
                await s.commit()
        finally:
            await eng.dispose()

    async def _run() -> list[str]:
        worker = asyncio.create_task(_fake_worker())
        collected: list[str] = []
        async for chunk in sse_relay.relay_stream_chunks(
            system_prompt="sys",
            history=[("user", "前")],
            user_message="こんにちは",
            thread_id=seeded["thread"],
            actor_id=seeded["u_a"],
        ):
            collected.append(chunk)
        await worker
        return collected

    collected = asyncio.run(_run())
    assert "".join(collected) == "やあ、こんにちは!"


@pytest.mark.integration
def test_relay_stream_worker_error_raises(
    seeded: dict[str, str],
    sync_engine: sqlalchemy.Engine,
    relay_test_factory: object,
) -> None:
    """worker が error で確定したら RelayFailed。"""
    _ping_worker(sync_engine)

    async def _fake_worker() -> None:
        eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
        try:
            for _ in range(80):
                async with AsyncSession(eng) as s:
                    picked = await chat_relay.pick_job(s, worker_id="relay-test#1")
                    await s.commit()
                if picked is not None:
                    async with AsyncSession(eng) as s:
                        await chat_relay.complete_job(
                            s, job_id=picked["job_id"], ok=False, error="claude 実行失敗"
                        )
                        await s.commit()
                    return
                await asyncio.sleep(0.05)
        finally:
            await eng.dispose()

    async def _run() -> None:
        worker = asyncio.create_task(_fake_worker())
        gen = sse_relay.relay_stream_chunks(
            system_prompt="s",
            history=[],
            user_message="u",
            thread_id=seeded["thread"],
            actor_id=seeded["u_a"],
        )
        with pytest.raises(sse_relay.RelayFailed):
            async for _ in gen:
                pass
        await worker

    asyncio.run(_run())


@pytest.mark.integration
def test_relay_stream_timeout_expires_job(
    seeded: dict[str, str],
    sync_engine: sqlalchemy.Engine,
    relay_test_factory: object,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """誰も拾わない job はタイムアウトで expired + RelayTimeout。"""
    _ping_worker(sync_engine)
    monkeypatch.setenv(sse_relay.TIMEOUT_ENV, "1")

    async def _run() -> None:
        gen = sse_relay.relay_stream_chunks(
            system_prompt="s",
            history=[],
            user_message="u",
            thread_id=seeded["thread"],
            actor_id=seeded["u_a"],
        )
        with pytest.raises(sse_relay.RelayTimeout):
            async for _ in gen:
                pass

    asyncio.run(_run())
    with sync_engine.connect() as c:
        status = c.execute(
            text(
                "select status from public.chat_relay_jobs "
                "where thread_id=cast(:t as uuid) order by created_at desc limit 1"
            ),
            {"t": seeded["thread"]},
        ).scalar_one()
        assert status == "expired"
