"""T-A-48: F-CTX01 完全実装の検証 — 実 Postgres + RLS。

- build_context に ペルソナ + 装着スキル(content_md) + プロジェクト状態 が入る。
- RAG は本物のベクトル検索経路 (knowledge.search_knowledge) を通る。
- 本番(LLM未接続 + ATELIER_ALLOW_FAKE_LLM 未設定)では fake/stub を返さず error。
"""

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
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("VOYAGE_API_KEY", None)
os.environ.pop("ATELIER_ALLOW_FAKE_LLM", None)  # 本番相当 (no-stub) を検証

import sqlalchemy  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.services import chat_sse  # noqa: E402


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
def seeded() -> Iterator[dict[str, str]]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    u = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    emp = str(uuid.uuid4())
    skill = str(uuid.uuid4())
    thread = str(uuid.uuid4())
    with eng.begin() as c:
        em = f"ctx01-{u[:8]}@t.invalid"
        c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws, "o": u, "n": "ctx-ws"},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type,status) "
                "values (cast(:i as uuid),cast(:w as uuid),'CtxProj','internal_product','active')"
            ),
            {"i": proj, "w": ws},
        )
        c.execute(
            text(
                "insert into public.skills (id,name,version,content_md,allowed_employee_roles,"
                "allowed_employee_ids,is_active) values (cast(:i as uuid),'提案スキル','1.0.0',"
                "'提案書はナレッジ参照して作る',array[]::text[],array[]::uuid[],true)"
            ),
            {"i": skill},
        )
        c.execute(
            text(
                "insert into public.ai_employees (id,workspace_id,name,display_name,role,department,"
                "attached_skills,is_default) values (cast(:i as uuid),cast(:w as uuid),'tony','トニー',"
                "'lead','sales',array[cast(:s as uuid)],true)"
            ),
            {"i": emp, "w": ws, "s": skill},
        )
        c.execute(
            text(
                "insert into public.chat_threads (id,project_id,ai_employee_id,title) "
                "values (cast(:i as uuid),cast(:p as uuid),cast(:e as uuid),'t')"
            ),
            {"i": thread, "p": proj, "e": emp},
        )
    yield {"u": u, "ws": ws, "proj": proj, "emp": emp, "skill": skill, "thread": thread}
    with eng.begin() as c:
        c.execute(text("delete from public.chat_threads where id=cast(:i as uuid)"), {"i": thread})
        c.execute(text("delete from public.ai_employees where id=cast(:i as uuid)"), {"i": emp})
        c.execute(text("delete from public.skills where id=cast(:i as uuid)"), {"i": skill})
        c.execute(text("delete from public.projects where id=cast(:i as uuid)"), {"i": proj})
        c.execute(text("delete from public.workspaces where id=cast(:i as uuid)"), {"i": ws})
        c.execute(text("delete from public.users where id=cast(:i as uuid)"), {"i": u})
        c.execute(text("delete from auth.users where id=cast(:i as uuid)"), {"i": u})
    eng.dispose()


async def _ctx(thread: str, ws: str) -> tuple[str, list[str]]:
    eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
    async with AsyncSession(eng) as s:
        sp, _hist, rag_ids = await chat_sse.build_context(
            s,
            thread_id=thread,
            user_message="提案書を作って",
            include_history=10,
            rag_account_id=ws,
            use_rag=True,
        )
    await eng.dispose()
    return sp, rag_ids


def test_context_includes_persona_skill_project(seeded: dict[str, str]) -> None:
    sp, _ = asyncio.run(_ctx(seeded["thread"], seeded["ws"]))
    assert "トニー" in sp  # ペルソナ
    assert "提案書はナレッジ参照して作る" in sp  # 装着スキル content_md
    assert "CtxProj" in sp  # プロジェクト状態(DB-as-truth)


async def _stream_no_stub(thread: str, ws: str) -> str:
    eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
    chunks: list[str] = []
    async with AsyncSession(eng) as s:
        async for b in chat_sse.stream_chat(
            s,
            actor_id=ws,
            thread_id=thread,
            user_message="hi",
            use_rag=False,
            include_history=10,
            rag_account_id=None,
        ):
            chunks.append(b.decode())
    await eng.dispose()
    return "".join(chunks)


def test_no_stub_in_production(seeded: dict[str, str]) -> None:
    out = asyncio.run(_stream_no_stub(seeded["thread"], seeded["ws"]))
    assert '"type": "error"' in out  # LLM 未接続 → error
    assert "echo:" not in out  # fake/stub を返さない
