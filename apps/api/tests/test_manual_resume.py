"""GAP-185: 止まったものを「言えば再開できる」ことの unit tests (実 PG)。

経営者判断「自動はしなくていいけど、止まった状態で進めてと言ったりしたら
再開はできる状態にしておかないとね」。

固定する挙動:
  - 保留中 (PC 未接続 / プラン枠の上限) の解析を、人の操作で今すぐ実行できる
  - まだ実行できないなら保留のまま残し、その旨を返す (嘘の成功を出さない)
  - 保留でないものに「再開」と言われても、誤解を招く返事をしない
  - 自動実行 (スケジュール) も 1 件だけ今すぐ動かせる。next_run_at はずらさない
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false
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

from src.services.cron.dispatcher import run_one_now
from src.services.meetings.resume import resume_analysis

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


async def _seed_project(session: AsyncSession) -> dict[str, str]:
    uid, ws, proj = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    email = f"g185-{uid[:8]}@example.com"
    await session.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.users (id,email,display_name) values (cast(:u as uuid),:e,'G185')"
        ),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G185 WS')"
        ),
        {"w": ws, "u": uid},
    )
    await session.execute(
        text(
            "insert into public.workspace_memberships (workspace_id,user_id,role) "
            "values (cast(:w as uuid),cast(:u as uuid),'owner') on conflict do nothing"
        ),
        {"w": ws, "u": uid},
    )
    await session.execute(
        text(
            "insert into public.projects (id,workspace_id,name,project_type,status) "
            "values (cast(:p as uuid),cast(:w as uuid),'G185案件','client_work','active')"
        ),
        {"p": proj, "w": ws},
    )
    await session.execute(
        text(
            "insert into public.ai_employees "
            "(workspace_id,name,display_name,role,department) "
            "values (cast(:w as uuid),'tony','トニー','coo','executive') "
            "on conflict (workspace_id,name) do nothing"
        ),
        {"w": ws},
    )
    await session.commit()
    return {"user": uid, "workspace": ws, "project": proj}


async def _seed_meeting(
    session: AsyncSession, *, project: str, uploader: str, pending: bool
) -> str:
    """文字起こしは完了済み、解析だけ保留 (= GAP-177 の状態) の行を作る。"""
    mid = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.external_uploads "
            "(id, project_id, uploaded_by_user_id, type, storage_path, file_name, "
            " file_size_bytes, mime_type, parsed_at, parse_result_path, "
            " analysis_pending_since) "
            "values (cast(:i as uuid), cast(:p as uuid), cast(:u as uuid), 'audio', "
            " :sp, 'a.mp3', 1024, 'audio/mpeg', now(), :rp, :ps)"
        ),
        {
            "i": mid,
            "p": project,
            "u": uploader,
            "sp": f"meetings/{mid}.mp3",
            "rp": f"transcripts/results/{mid}.json",
            "ps": datetime.now(tz=UTC) if pending else None,
        },
    )
    await session.commit()
    return mid


class TestResumeMeetingAnalysis:
    async def test_not_pending_is_reported_clearly(self, session: AsyncSession) -> None:
        env = await _seed_project(session)
        mid = await _seed_meeting(
            session, project=env["project"], uploader=env["user"], pending=False
        )
        result = await resume_analysis(session, meeting_id=mid)
        assert result.status == "not_pending"
        assert "保留中の解析はありません" in result.message

    async def test_missing_meeting_is_reported(self, session: AsyncSession) -> None:
        result = await resume_analysis(session, meeting_id=str(uuid.uuid4()))
        assert result.status == "not_found"

    async def test_still_offline_keeps_the_hold_and_says_so(
        self, session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """まだ実行できないなら「やった」と嘘をつかず保留のまま残す。"""
        env = await _seed_project(session)
        mid = await _seed_meeting(
            session, project=env["project"], uploader=env["user"], pending=True
        )

        from src.services.meetings import worker as worker_mod

        async def _still_pending(_s: object, _row: object) -> bool:
            return False

        monkeypatch.setattr(worker_mod, "retry_analysis_one", _still_pending)
        result = await resume_analysis(session, meeting_id=mid)
        assert result.status == "still_pending"
        assert "もう一度お試しください" in result.message

        row = (
            await session.execute(
                text(
                    "select analysis_pending_since from public.external_uploads "
                    "where id = cast(:i as uuid)"
                ),
                {"i": mid},
            )
        ).first()
        assert row is not None and row.analysis_pending_since is not None

    async def test_success_reports_done(
        self, session: AsyncSession, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        env = await _seed_project(session)
        mid = await _seed_meeting(
            session, project=env["project"], uploader=env["user"], pending=True
        )

        from src.services.meetings import worker as worker_mod

        async def _ok(_s: object, _row: object) -> bool:
            return True

        monkeypatch.setattr(worker_mod, "retry_analysis_one", _ok)
        result = await resume_analysis(session, meeting_id=mid)
        assert result.status == "done"


class TestRunScheduleNow:
    async def _seed_schedule(
        self, session: AsyncSession, *, project: str, enabled: bool = True
    ) -> tuple[str, datetime]:
        sched = str(uuid.uuid4())
        future = datetime.now(tz=UTC) + timedelta(days=1)
        await session.execute(
            text(
                "insert into public.cron_schedules "
                "(id, project_id, name, cron_expression, target_action, enabled, next_run_at) "
                "values (cast(:s as uuid), cast(:p as uuid), '手動テスト', '0 9 * * *', "
                " 'daily_digest', :en, :nr)"
            ),
            {"s": sched, "p": project, "en": enabled, "nr": future},
        )
        await session.commit()
        return sched, future

    async def test_runs_immediately_without_moving_the_schedule(
        self, session: AsyncSession
    ) -> None:
        """手動実行で定期スケジュールをずらさない。"""
        env = await _seed_project(session)
        sched, future = await self._seed_schedule(session, project=env["project"])

        result = await run_one_now(session, schedule_id=sched)
        assert result["status"] == "done"

        row = (
            await session.execute(
                text("select next_run_at from public.cron_schedules where id = cast(:s as uuid)"),
                {"s": sched},
            )
        ).first()
        assert row is not None
        assert abs((row.next_run_at - future).total_seconds()) < 1

    async def test_records_the_run_in_history(self, session: AsyncSession) -> None:
        env = await _seed_project(session)
        sched, _ = await self._seed_schedule(session, project=env["project"])
        await run_one_now(session, schedule_id=sched)
        count = (
            await session.execute(
                text(
                    "select count(*) from public.cron_run_history "
                    "where schedule_id = cast(:s as uuid)"
                ),
                {"s": sched},
            )
        ).scalar_one()
        assert int(count) == 1

    async def test_disabled_schedule_can_still_be_pushed_once(self, session: AsyncSession) -> None:
        """止まっているものを進めたい場面があるので、無効でも 1 回は動かせる。"""
        env = await _seed_project(session)
        sched, _ = await self._seed_schedule(session, project=env["project"], enabled=False)
        result = await run_one_now(session, schedule_id=sched)
        assert result["status"] == "done"

    async def test_missing_schedule_is_reported(self, session: AsyncSession) -> None:
        result = await run_one_now(session, schedule_id=str(uuid.uuid4()))
        assert result["status"] == "not_found"

    async def test_deferred_is_not_reported_as_success(self, session: AsyncSession) -> None:
        """PC 未接続・上限のときに「実行しました」と嘘をつかない。"""
        env = await _seed_project(session)
        sched = str(uuid.uuid4())
        await session.execute(
            text(
                "insert into public.cron_schedules "
                "(id, project_id, name, cron_expression, target_action, enabled, next_run_at) "
                "values (cast(:s as uuid), cast(:p as uuid), '要 PC', '0 9 * * *', "
                " 'report_summary', true, :nr)"
            ),
            {
                "s": sched,
                "p": env["project"],
                "nr": datetime.now(tz=UTC) + timedelta(days=1),
            },
        )
        await session.commit()

        from src.services.chat_sse.llm_chain import LLMUnavailable

        async def _limited(**_kw: Any) -> tuple[str, str]:
            raise LLMUnavailable("rate_limited", "上限です")

        result = await run_one_now(session, schedule_id=sched, complete=_limited)
        assert result["status"] == "deferred"
        assert "もう一度お試しください" in result["message"]
