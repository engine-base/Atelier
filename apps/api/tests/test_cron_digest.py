"""T-A-53: daily_digest 実体 — 3-tier AC テスト (実 PG)。

tier 2 (functional): 発火→「日次ダイジェスト」thread に assistant message + audit。
tier 2 (functional): 同日 2 回目はスキップ (冪等)。
tier 2 (UNWANTED):   対象 0 件でも例外にしない。
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false
from __future__ import annotations

import os
import uuid

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from src.services.cron.digest import DIGEST_THREAD_TITLE, run_daily_digest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")


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


@pytest.fixture
async def session():
    engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


@pytest.fixture
async def seeded(session: AsyncSession) -> dict[str, str]:
    """digest 用の workspace/project/schedule を新規 seed する (他テストと非干渉)。"""
    uid = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    sched = str(uuid.uuid4())
    await session.execute(
        text("insert into auth.users (id, email) values (cast(:u as uuid), :e)"),
        {"u": uid, "e": f"digest-{uid[:8]}@example.com"},
    )
    await session.execute(
        text(
            "insert into public.users (id, email, display_name) values (cast(:u as uuid), :e, 'D')"
        ),
        {"u": uid, "e": f"digest-{uid[:8]}@example.com"},
    )
    await session.execute(
        text(
            "insert into public.workspaces (id, owner_user_id, name) "
            "values (cast(:w as uuid), cast(:u as uuid), 'Digest WS')"
        ),
        {"w": ws, "u": uid},
    )
    await session.execute(
        text(
            "insert into public.projects (id, workspace_id, name, project_type, status) "
            "values (cast(:p as uuid), cast(:w as uuid), 'Digest案件', 'client_work', 'active')"
        ),
        {"p": proj, "w": ws},
    )
    await session.execute(
        text(
            "insert into public.ai_employees (workspace_id, name, display_name, role, department) "
            "values (cast(:w as uuid), 'tony', 'トニー', 'coo', 'executive')"
        ),
        {"w": ws},
    )
    await session.execute(
        text(
            "insert into public.tasks (project_id, category, title, type, estimated_hours, lifecycle_stage) "
            "values (cast(:p as uuid), 'backend', 'D1', 'feature', 1, 'ready'), "
            "(cast(:p as uuid), 'backend', 'D2', 'feature', 2, 'in_progress')"
        ),
        {"p": proj},
    )
    await session.execute(
        text(
            "insert into public.cron_schedules (id, project_id, name, cron_expression, target_action) "
            "values (cast(:s as uuid), cast(:p as uuid), 'digest', '0 22 * * *', 'daily_digest')"
        ),
        {"s": sched, "p": proj},
    )
    await session.commit()
    return {"project": proj, "schedule": sched}


class TestRunDailyDigest:
    async def test_generates_thread_message_and_audit(
        self, session: AsyncSession, seeded: dict[str, str]
    ) -> None:
        result = await run_daily_digest(session)
        assert result["generated"] >= 1

        row = (
            await session.execute(
                text(
                    "select m.content from public.chat_messages m "
                    "join public.chat_threads t on t.id = m.thread_id "
                    "where t.project_id = cast(:p as uuid) and t.title = :title "
                    "and m.role = 'assistant'"
                ),
                {"p": seeded["project"], "title": DIGEST_THREAD_TITLE},
            )
        ).first()
        assert row is not None
        content = str(row.content)
        assert "日次ダイジェスト" in content
        assert "ready: 1 件" in content
        assert "in_progress: 1 件" in content

        audit = (
            await session.execute(
                text(
                    "select 1 from public.audit_logs "
                    "where action = 'cron.daily_digest.generate' "
                    "and after->>'project_id' = :p limit 1"
                ),
                {"p": seeded["project"]},
            )
        ).first()
        assert audit is not None

    async def test_idempotent_same_day(self, session: AsyncSession, seeded: dict[str, str]) -> None:
        await run_daily_digest(session)
        second = await run_daily_digest(session)
        assert second["skipped"] >= 1  # 同日分は再生成せず skip
        n = (
            await session.execute(
                text(
                    "select count(*) from public.chat_messages m "
                    "join public.chat_threads t on t.id = m.thread_id "
                    "where t.project_id = cast(:p as uuid) and t.title = :title"
                ),
                {"p": seeded["project"], "title": DIGEST_THREAD_TITLE},
            )
        ).scalar_one()
        assert n == 1

    async def test_zero_schedules_ok(self, session: AsyncSession) -> None:
        rows = (
            await session.execute(
                text(
                    "select id from public.cron_schedules "
                    "where enabled = true and target_action = 'daily_digest'"
                )
            )
        ).all()
        ids = [str(r.id) for r in rows]
        await session.execute(
            text(
                "update public.cron_schedules set enabled = false where id = any(cast(:ids as uuid[]))"
            ),
            {"ids": ids},
        )
        await session.commit()
        try:
            result = await run_daily_digest(session)
            assert result == {"generated": 0, "skipped": 0}
        finally:
            await session.execute(
                text(
                    "update public.cron_schedules set enabled = true where id = any(cast(:ids as uuid[]))"
                ),
                {"ids": ids},
            )
            await session.commit()
