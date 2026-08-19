"""GAP-183: 自動実行の見張りを利用者の PC から叩く経路 (実 PG)。

クラウドに毎分 cron を置くと Fly.io のアイドル停止が効かず運営に固定費が出る。
PC が動いている間はこの endpoint が時計を務める (運営コスト 0 円)。
ここでは「本人の workspace の分だけ動く」ことと「二重実行が起きない」ことを固定する。
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.cron.dispatcher import run_due_schedules

UTC = ZoneInfo("UTC")

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


async def _seed(session: AsyncSession) -> dict[str, str]:
    uid, ws, proj = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    email = f"g183-{uid[:8]}@example.com"
    await session.execute(
        text("insert into auth.users (id, email) values (cast(:u as uuid), :e)"),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.users (id, email, display_name) "
            "values (cast(:u as uuid), :e, 'G183')"
        ),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.workspaces (id, owner_user_id, name) "
            "values (cast(:w as uuid), cast(:u as uuid), 'G183 WS')"
        ),
        {"w": ws, "u": uid},
    )
    await session.execute(
        text(
            "insert into public.workspace_memberships (workspace_id, user_id, role) "
            "values (cast(:w as uuid), cast(:u as uuid), 'owner') on conflict do nothing"
        ),
        {"w": ws, "u": uid},
    )
    await session.execute(
        text(
            "insert into public.projects (id, workspace_id, name, project_type, status) "
            "values (cast(:p as uuid), cast(:w as uuid), 'G183案件', 'client_work', 'active')"
        ),
        {"p": proj, "w": ws},
    )
    await session.execute(
        text(
            "insert into public.ai_employees (workspace_id, name, display_name, role, department) "
            "values (cast(:w as uuid), 'tony', 'トニー', 'coo', 'executive') "
            "on conflict (workspace_id, name) do nothing"
        ),
        {"w": ws},
    )
    sched = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.cron_schedules "
            "(id, project_id, name, cron_expression, target_action, enabled, next_run_at) "
            "values (cast(:s as uuid), cast(:p as uuid), 'テスト', '0 9 * * *', "
            " 'daily_digest', true, :nr)"
        ),
        {"s": sched, "p": proj, "nr": datetime.now(tz=UTC) - timedelta(minutes=1)},
    )
    await session.commit()
    return {"user": uid, "project": proj, "schedule": sched}


@pytest.fixture
async def session():
    engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


class TestPerUserScope:
    async def test_only_runs_own_workspace_schedules(self, session: AsyncSession) -> None:
        """他人の PC が他社の予定を動かさない。"""
        mine = await _seed(session)
        theirs = await _seed(session)

        stats = await run_due_schedules(session, user_id=mine["user"])
        assert stats["due"] >= 1

        ran = (
            await session.execute(
                text(
                    "select count(*) from public.cron_run_history "
                    "where schedule_id = cast(:s as uuid)"
                ),
                {"s": mine["schedule"]},
            )
        ).scalar_one()
        assert int(ran) >= 1

        others = (
            await session.execute(
                text(
                    "select count(*) from public.cron_run_history "
                    "where schedule_id = cast(:s as uuid)"
                ),
                {"s": theirs["schedule"]},
            )
        ).scalar_one()
        assert int(others) == 0  # 他人の分は動かしていない


class TestNoDoubleExecution:
    async def test_two_watchers_do_not_run_the_same_schedule_twice(self) -> None:
        """PC とクラウドが同時に叩いても二重実行にならない (行ロック)。

        AI を使う自動実行が二重に走ると利用者のプラン枠を無駄に消費するため、
        ここは「たまたま大丈夫」ではなく構造で防ぐ必要がある。
        """
        engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        async with factory() as setup:
            env = await _seed(setup)

        async def _watcher() -> dict[str, int]:
            async with factory() as s:
                return await run_due_schedules(s, user_id=env["user"])

        results = await asyncio.gather(_watcher(), _watcher())
        await engine.dispose()

        total_due = sum(r["due"] for r in results)
        assert total_due == 1, f"同じ行を 2 回拾っている: {results}"

        engine2 = create_async_engine(PG_ASYNC, poolclass=NullPool)
        async with async_sessionmaker(engine2, expire_on_commit=False)() as s:
            runs = (
                await s.execute(
                    text(
                        "select count(*) from public.cron_run_history "
                        "where schedule_id = cast(:s as uuid)"
                    ),
                    {"s": env["schedule"]},
                )
            ).scalar_one()
        await engine2.dispose()
        assert int(runs) == 1
