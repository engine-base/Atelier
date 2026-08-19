"""GAP-179: 自動実行 (cron_schedules) が実際に走ることの e2e テスト (実 PG)。

**これまでの実態**: 画面で選べる 6 種類のうち動くのは daily_digest だけで、
利用者が入れた cron 式も next_run_at も一度も使われていなかった。
ここでは「指定時刻に発火する」「6 種類すべてに実体がある」「PC 未接続は
嘘の成功ではなく保留として記録され再試行される」を実データで固定する。
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.cron.actions import ACTION_SPECS
from src.services.cron.burndown import BURNDOWN_THREAD_TITLE
from src.services.cron.dispatcher import RETRY_AFTER_MINUTES, run_due_schedules

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


@pytest.fixture
async def session():
    engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


@pytest.fixture
async def env(session: AsyncSession) -> dict[str, str]:
    """workspace / project / owner / AI 社員 を新規 seed する。"""
    uid = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    email = f"cron-{uid[:8]}@example.com"
    await session.execute(
        text("insert into auth.users (id, email) values (cast(:u as uuid), :e)"),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.users (id, email, display_name) "
            "values (cast(:u as uuid), :e, 'Cron')"
        ),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.workspaces (id, owner_user_id, name) "
            "values (cast(:w as uuid), cast(:u as uuid), 'Cron WS')"
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
            "values (cast(:p as uuid), cast(:w as uuid), 'Cron案件', 'client_work', 'active')"
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
    await session.commit()
    return {"user": uid, "workspace": ws, "project": proj}


async def _add_schedule(
    session: AsyncSession,
    *,
    project_id: str,
    action: str,
    expression: str = "0 9 * * *",
    next_run_at: datetime | None,
    enabled: bool = True,
) -> str:
    sched = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.cron_schedules "
            "(id, project_id, name, cron_expression, target_action, enabled, next_run_at) "
            "values (cast(:s as uuid), cast(:p as uuid), :n, :ce, :ta, :en, :nr)"
        ),
        {
            "s": sched,
            "p": project_id,
            "n": f"テスト-{action}",
            "ce": expression,
            "ta": action,
            "en": enabled,
            "nr": next_run_at,
        },
    )
    await session.commit()
    return sched


async def _schedule_row(session: AsyncSession, schedule_id: str) -> Any:
    return (
        await session.execute(
            text(
                "select enabled, next_run_at from public.cron_schedules where id = cast(:s as uuid)"
            ),
            {"s": schedule_id},
        )
    ).first()


async def _last_run(session: AsyncSession, schedule_id: str) -> Any:
    return (
        await session.execute(
            text(
                "select status, detail from public.cron_run_history "
                "where schedule_id = cast(:s as uuid) order by started_at desc limit 1"
            ),
            {"s": schedule_id},
        )
    ).first()


class TestRegistryCoversEveryAction:
    def test_every_selectable_action_has_a_real_runner(self) -> None:
        """画面で選べる 6 種類すべてに実体があること (5 種類が空だった回帰)。"""
        from src.schemas.cron import CronTargetAction

        selectable = set(CronTargetAction.__args__)  # type: ignore[attr-defined]
        assert selectable == set(ACTION_SPECS)
        for spec in ACTION_SPECS.values():
            assert callable(spec.run)
            assert spec.cost_label in ("本人の Claude プラン枠", "コスト無料")

    def test_no_action_claims_byok_api(self) -> None:
        """「BYOK API 使用」という誤表示が二度と出ないこと (GAP-175/179)。"""
        for spec in ACTION_SPECS.values():
            assert "BYOK" not in spec.cost_label
            assert "API" not in spec.cost_label


class TestDispatcherTiming:
    async def test_runs_only_when_due(self, session: AsyncSession, env: dict[str, str]) -> None:
        future = datetime.now(tz=UTC) + timedelta(hours=5)
        sched = await _add_schedule(
            session, project_id=env["project"], action="daily_digest", next_run_at=future
        )
        await run_due_schedules(session)
        # 他テストのスケジュールも同居するので、この行が動いていないことで判定する
        assert await _last_run(session, sched) is None
        row = await _schedule_row(session, sched)
        assert row.next_run_at == future

    async def test_due_schedule_runs_and_advances_next_run(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        past = datetime.now(tz=UTC) - timedelta(minutes=1)
        sched = await _add_schedule(
            session, project_id=env["project"], action="daily_digest", next_run_at=past
        )
        stats = await run_due_schedules(session)
        assert stats["ran"] >= 1

        run = await _last_run(session, sched)
        assert run is not None
        assert run.status == "success"

        row = await _schedule_row(session, sched)
        assert row.next_run_at > datetime.now(tz=UTC)

    async def test_null_next_run_is_computed_not_executed(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        """next_run_at 未計算の行は「今すぐ実行」ではなく次回時刻の確定を行う。"""
        sched = await _add_schedule(
            session, project_id=env["project"], action="daily_digest", next_run_at=None
        )
        stats = await run_due_schedules(session)
        assert stats["scheduled"] >= 1
        row = await _schedule_row(session, sched)
        assert row.next_run_at is not None
        assert await _last_run(session, sched) is None

    async def test_disabled_schedule_is_ignored(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        past = datetime.now(tz=UTC) - timedelta(minutes=1)
        sched = await _add_schedule(
            session,
            project_id=env["project"],
            action="daily_digest",
            next_run_at=past,
            enabled=False,
        )
        await run_due_schedules(session)
        assert await _last_run(session, sched) is None


class TestDeferredWhenPcOffline:
    async def test_bridge_offline_is_recorded_as_deferred_and_retried_soon(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        """PC 未接続を「成功」とも「失敗」とも書かず、保留として短時間で再試行する。"""
        await session.execute(
            text(
                "insert into public.knowledge_nodes "
                "(account_id, account_type, scope, category, tags, title, content_md, "
                " source_project_id) "
                "values (cast(:w as uuid), 'workspace', 'project', '未分類', "
                " array[]::text[], :t, '本文', cast(:p as uuid))"
            ),
            {"w": env["workspace"], "p": env["project"], "t": f"未整理-{uuid.uuid4().hex[:6]}"},
        )
        await session.commit()

        past = datetime.now(tz=UTC) - timedelta(minutes=1)
        sched = await _add_schedule(
            session, project_id=env["project"], action="knowledge_organize", next_run_at=past
        )

        from src.services.chat_sse.llm_chain import LLMUnavailable

        async def _offline(**_kwargs: Any) -> tuple[str, str]:
            raise LLMUnavailable("bridge_offline", "PC が接続されていません")

        before = datetime.now(tz=UTC)
        stats = await run_due_schedules(session, complete=_offline)
        assert stats["deferred"] >= 1

        run = await _last_run(session, sched)
        assert run is not None
        assert run.status == "deferred"
        assert run.detail["reason"] == "bridge_offline"

        row = await _schedule_row(session, sched)
        assert row.next_run_at <= before + timedelta(minutes=RETRY_AFTER_MINUTES + 1)
        assert row.next_run_at > before


class TestEveryActionActuallyDoesSomething:
    async def test_weekly_burndown_posts_a_report(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        await session.execute(
            text(
                "insert into public.tasks "
                "(project_id, category, title, type, estimated_hours, lifecycle_stage) "
                "values (cast(:p as uuid), 'backend', 'B1', 'feature', 1, 'done'), "
                "(cast(:p as uuid), 'backend', 'B2', 'feature', 1, 'ready')"
            ),
            {"p": env["project"]},
        )
        await session.commit()
        past = datetime.now(tz=UTC) - timedelta(minutes=1)
        await _add_schedule(
            session, project_id=env["project"], action="weekly_burndown", next_run_at=past
        )
        await run_due_schedules(session)

        row = (
            await session.execute(
                text(
                    "select m.content from public.chat_messages m "
                    "join public.chat_threads t on t.id = m.thread_id "
                    "where t.project_id = cast(:p as uuid) and t.title = :title"
                ),
                {"p": env["project"], "title": BURNDOWN_THREAD_TITLE},
            )
        ).first()
        assert row is not None
        assert "週次バーンダウン" in str(row.content)
        assert "完了 1 / 全 2 件" in str(row.content)

    async def test_task_replay_enqueues_ready_tasks(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        await session.execute(
            text(
                "insert into public.tasks "
                "(project_id, category, title, type, estimated_hours, lifecycle_stage) "
                "values (cast(:p as uuid), 'backend', 'R1', 'feature', 1, 'ready')"
            ),
            {"p": env["project"]},
        )
        await session.commit()
        past = datetime.now(tz=UTC) - timedelta(minutes=1)
        sched = await _add_schedule(
            session, project_id=env["project"], action="task_replay", next_run_at=past
        )
        await run_due_schedules(session)

        run = await _last_run(session, sched)
        assert run is not None
        assert run.status == "success"
        queued = (
            await session.execute(
                text(
                    "select count(*) from public.tasks where project_id = cast(:p as uuid) "
                    "and dispatch_status = 'queued'"
                ),
                {"p": env["project"]},
            )
        ).scalar_one()
        assert int(queued) >= 1
        # 他テストの dispatcher 検証を汚さないよう、投入したキューは戻す
        await session.execute(
            text(
                "update public.tasks set dispatch_status = null where project_id = cast(:p as uuid)"
            ),
            {"p": env["project"]},
        )
        await session.commit()

    async def test_industry_extract_proposes_candidates_for_approval(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        tag = f"tag-{uuid.uuid4().hex[:6]}"
        for i in range(2):
            await session.execute(
                text(
                    "insert into public.knowledge_nodes "
                    "(account_id, account_type, scope, category, tags, title, content_md) "
                    "values (cast(:w as uuid), 'workspace', 'project', '技術', "
                    " array[:tag]::text[], :t, '本文')"
                ),
                {"w": env["workspace"], "tag": tag, "t": f"N{i}-{uuid.uuid4().hex[:6]}"},
            )
        await session.commit()
        past = datetime.now(tz=UTC) - timedelta(minutes=1)
        await _add_schedule(
            session, project_id=env["project"], action="industry_extract", next_run_at=past
        )
        await run_due_schedules(session)

        found = (
            await session.execute(
                text(
                    "select count(*) from public.knowledge_candidates "
                    "where workspace_id = cast(:w as uuid) and status = 'pending' "
                    "and category = '業界パターン'"
                ),
                {"w": env["workspace"]},
            )
        ).scalar_one()
        assert int(found) >= 1

    async def test_knowledge_organize_applies_tags(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        title = f"未整理-{uuid.uuid4().hex[:6]}"
        node_id = (
            await session.execute(
                text(
                    "insert into public.knowledge_nodes "
                    "(account_id, account_type, scope, category, tags, title, content_md, "
                    " source_project_id) "
                    "values (cast(:w as uuid), 'workspace', 'project', '未分類', "
                    " array[]::text[], :t, '本文', cast(:p as uuid)) returning id"
                ),
                {"w": env["workspace"], "p": env["project"], "t": title},
            )
        ).scalar_one()
        await session.commit()

        async def _complete(**_kwargs: Any) -> tuple[str, str]:
            return (
                f'[{{"id": "{node_id}", "category": "技術", "tags": ["Next.js", "RLS"]}}]',
                "relay",
            )

        past = datetime.now(tz=UTC) - timedelta(minutes=1)
        await _add_schedule(
            session, project_id=env["project"], action="knowledge_organize", next_run_at=past
        )
        await run_due_schedules(session, complete=_complete)

        row = (
            await session.execute(
                text(
                    "select category, tags from public.knowledge_nodes where id = cast(:i as uuid)"
                ),
                {"i": str(node_id)},
            )
        ).first()
        assert row is not None
        assert row.category == "技術"
        assert set(row.tags) == {"Next.js", "RLS"}

    async def test_report_summary_posts_generated_report(
        self, session: AsyncSession, env: dict[str, str]
    ) -> None:
        async def _complete(**kwargs: Any) -> tuple[str, str]:
            # 材料が DB 実数値であることも確認する (創作させない設計)
            assert "タスク状況" in str(kwargs["user_text"])
            return ("## 今週の状況\n順調です。", "relay")

        past = datetime.now(tz=UTC) - timedelta(minutes=1)
        await _add_schedule(
            session, project_id=env["project"], action="report_summary", next_run_at=past
        )
        await run_due_schedules(session, complete=_complete)

        from src.services.cron.actions import REPORT_THREAD_TITLE

        row = (
            await session.execute(
                text(
                    "select m.content from public.chat_messages m "
                    "join public.chat_threads t on t.id = m.thread_id "
                    "where t.project_id = cast(:p as uuid) and t.title = :title"
                ),
                {"p": env["project"], "title": REPORT_THREAD_TITLE},
            )
        ).first()
        assert row is not None
        assert "今週の状況" in str(row.content)
