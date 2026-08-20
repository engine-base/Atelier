"""GAP-190: スレッドごとに「同じ Claude セッション」で走らせる unit tests (実 PG)。

経営者確認「そのセッション内ではずっと同じターミナルのセッションとして走れる
という認識だよね？」→ 実 CLI で成立を確認済み。

固定する挙動:
  - スレッドは 1 つのセッション ID を持ち続ける (毎回作り直さない)
  - ジョブには「新しい発言だけ」と「履歴を畳んだもの」の両方が載る
    (どちらを使うかは Bridge が PC 上の実ファイルを見て決める)
  - Bridge が実際に使ったセッションでスレッドを上書きする = 自己修復
  - 中断されたターンでも、使ったセッションは記録する
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

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services import chat_relay
from src.services.chat_relay import session as session_svc

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


async def _seed(session: AsyncSession) -> dict[str, str]:
    uid, ws, proj, thread, emp = (str(uuid.uuid4()) for _ in range(5))
    email = f"g190-{uid[:8]}@example.com"
    await session.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.users (id,email,display_name) values (cast(:u as uuid),:e,'G190')"
        ),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G190 WS')"
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
            "values (cast(:p as uuid),cast(:w as uuid),'G190案件','client_work','active')"
        ),
        {"p": proj, "w": ws},
    )
    await session.execute(
        text(
            "insert into public.ai_employees "
            "(id,workspace_id,name,display_name,role,department) "
            "values (cast(:e as uuid),cast(:w as uuid),'tony','トニー','coo','executive')"
        ),
        {"e": emp, "w": ws},
    )
    await session.execute(
        text(
            "insert into public.chat_threads (id,project_id,ai_employee_id,title) "
            "values (cast(:t as uuid),cast(:p as uuid),cast(:e as uuid),'G190 スレッド')"
        ),
        {"t": thread, "p": proj, "e": emp},
    )
    await session.commit()
    return {"user": uid, "thread": thread}


async def _thread_session(session: AsyncSession, thread: str):
    return (
        await session.execute(
            text(
                "select claude_session_id, claude_session_worker_id, claude_session_used_at "
                "from public.chat_threads where id = cast(:t as uuid)"
            ),
            {"t": thread},
        )
    ).first()


class TestThreadKeepsOneSession:
    async def test_session_is_minted_once_and_reused(self, session: AsyncSession) -> None:
        """毎回作り直さない — 同じスレッドはずっと同じセッション。"""
        env = await _seed(session)
        first = await session_svc.ensure_thread_session(session, thread_id=env["thread"])
        await session.commit()
        second = await session_svc.ensure_thread_session(session, thread_id=env["thread"])
        await session.commit()
        assert first.session_id == second.session_id
        row = await _thread_session(session, env["thread"])
        assert row is not None and str(row.claude_session_id) == first.session_id

    async def test_new_session_is_not_yet_established(self, session: AsyncSession) -> None:
        """採番しただけでは「その PC に実体がある」ことにはならない。"""
        env = await _seed(session)
        s = await session_svc.ensure_thread_session(session, thread_id=env["thread"])
        assert s.established is False
        assert s.worker_id is None

    async def test_unknown_thread_still_yields_a_session(self, session: AsyncSession) -> None:
        """スレッドが無くても落ちない (呼び出し側を壊さない)。"""
        s = await session_svc.ensure_thread_session(session, thread_id=str(uuid.uuid4()))
        assert uuid.UUID(s.session_id)

    async def test_clearing_starts_a_new_conversation(self, session: AsyncSession) -> None:
        env = await _seed(session)
        first = await session_svc.ensure_thread_session(session, thread_id=env["thread"])
        await session.commit()
        await session_svc.clear_thread_session(session, thread_id=env["thread"])
        await session.commit()
        second = await session_svc.ensure_thread_session(session, thread_id=env["thread"])
        await session.commit()
        assert first.session_id != second.session_id


class TestJobCarriesBothPrompts:
    async def test_job_has_new_message_and_folded_history(self, session: AsyncSession) -> None:
        """どちらを使うかは Bridge が決めるので、両方載せる。"""
        env = await _seed(session)
        sid = (await session_svc.ensure_thread_session(session, thread_id=env["thread"])).session_id
        job = await chat_relay.enqueue_job(
            session,
            thread_id=env["thread"],
            requested_by=env["user"],
            system_prompt="SYS",
            prompt="新しい発言",
            session_id=sid,
            prompt_full="これまでの履歴\n新しい発言",
        )
        await session.commit()

        picked = await chat_relay.pick_job(session, worker_id="pc-1", requested_by=env["user"])
        await session.commit()
        assert picked is not None and picked["job_id"] == job
        assert picked["prompt"] == "新しい発言"
        assert picked["prompt_full"] == "これまでの履歴\n新しい発言"
        assert picked["session_id"] == sid

    async def test_system_jobs_have_no_session(self, session: AsyncSession) -> None:
        """モック生成等の thread 無しジョブはセッションを使わない。"""
        env = await _seed(session)
        await chat_relay.enqueue_job(
            session,
            thread_id=None,
            requested_by=env["user"],
            system_prompt="SYS",
            prompt="裏方の指示",
        )
        await session.commit()
        picked = await chat_relay.pick_job(session, worker_id="pc-1", requested_by=env["user"])
        await session.commit()
        assert picked is not None
        assert picked["session_id"] is None
        assert picked["prompt_full"] is None


class TestBridgeReportIsTheTruth:
    async def _running_job(
        self, session: AsyncSession, env: dict[str, str], sid: str | None
    ) -> str:
        job = await chat_relay.enqueue_job(
            session,
            thread_id=env["thread"],
            requested_by=env["user"],
            system_prompt="SYS",
            prompt="本文",
            session_id=sid,
            prompt_full="履歴込み",
        )
        await session.execute(
            text("update public.chat_relay_jobs set status='running' where id = cast(:i as uuid)"),
            {"i": job},
        )
        await chat_relay.append_chunks(session, job_id=job, seq_start=0, texts=["答え"])
        await session.commit()
        return job

    async def test_resumed_report_is_recorded(self, session: AsyncSession) -> None:
        env = await _seed(session)
        sid = (await session_svc.ensure_thread_session(session, thread_id=env["thread"])).session_id
        job = await self._running_job(session, env, sid)

        await chat_relay.complete_job(
            session, job_id=job, ok=True, session_id=sid, resumed=True, worker_id="pc-1"
        )
        await session.commit()

        row = (
            await session.execute(
                text(
                    "select session_id, resumed from public.chat_relay_jobs "
                    "where id = cast(:i as uuid)"
                ),
                {"i": job},
            )
        ).first()
        assert row is not None and str(row.session_id) == sid and row.resumed is True

        th = await _thread_session(session, env["thread"])
        assert th is not None
        assert str(th.claude_session_id) == sid
        assert str(th.claude_session_worker_id) == "pc-1"
        assert th.claude_session_used_at is not None

    async def test_bridge_minted_session_overwrites_the_thread(self, session: AsyncSession) -> None:
        """別 PC 等で再開できず Bridge が別 ID を使ったら、そちらを正にする。

        次のターンから確実に再開できるようにするための自己修復。
        """
        env = await _seed(session)
        wanted = (
            await session_svc.ensure_thread_session(session, thread_id=env["thread"])
        ).session_id
        job = await self._running_job(session, env, wanted)

        actual = str(uuid.uuid4())
        await chat_relay.complete_job(
            session, job_id=job, ok=True, session_id=actual, resumed=False, worker_id="pc-2"
        )
        await session.commit()

        th = await _thread_session(session, env["thread"])
        assert th is not None
        assert str(th.claude_session_id) == actual != wanted
        assert str(th.claude_session_worker_id) == "pc-2"

        # 次のターンは Bridge が実際に使った ID を渡す
        nxt = await session_svc.ensure_thread_session(session, thread_id=env["thread"])
        assert nxt.session_id == actual
        assert nxt.established is True

    async def test_cancelled_turn_still_records_the_session(self, session: AsyncSession) -> None:
        """中断でも「どのセッションで走ったか」は次のターンに要る事実。"""
        from src.services import chat_run

        env = await _seed(session)
        sid = (await session_svc.ensure_thread_session(session, thread_id=env["thread"])).session_id
        job = await self._running_job(session, env, sid)
        await chat_run.request_cancel(session, job_id=job, actor_id=env["user"])
        await session.commit()

        await chat_relay.complete_job(
            session,
            job_id=job,
            ok=False,
            error="[cancelled]",
            session_id=sid,
            resumed=True,
            worker_id="pc-1",
        )
        await session.commit()

        th = await _thread_session(session, env["thread"])
        assert th is not None and str(th.claude_session_id) == sid
        # 中断は done で塗り替えない (GAP-189 の約束を守る)
        status = (
            await session.execute(
                text("select status from public.chat_relay_jobs where id = cast(:i as uuid)"),
                {"i": job},
            )
        ).scalar_one()
        assert status == "cancelled"

    async def test_no_report_leaves_the_thread_untouched(self, session: AsyncSession) -> None:
        """報告が無いジョブ (セッション非対象) でスレッドを汚さない。"""
        env = await _seed(session)
        job = await self._running_job(session, env, None)
        await chat_relay.complete_job(session, job_id=job, ok=True)
        await session.commit()
        th = await _thread_session(session, env["thread"])
        assert th is not None and th.claude_session_id is None
