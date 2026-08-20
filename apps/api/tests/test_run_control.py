"""GAP-189: 実行の制御 (中断 / 追い足し / 繋ぎ直し) の unit tests (実 PG)。

経営者指摘:
    「中断とか入ってないけど、これ Claude だとできるけど」
    「止まっても裏のターミナルは変わらないんでしょ？ だったら続けてとかで
      自動で後ろは繋がるよね？」

固定する挙動:
  - 中断は終端。他人の実行は止められない。ここまでの本文は捨てない
  - Bridge は「止めろ」を読める (= PC 上の claude を実際に止められる)
  - 返答の保存は **ブラウザではなくサーバーのジョブ確定**に紐づく (冪等)
  - 追い足し指示は受領時点で保存され、二重消費しない
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

from src.services import chat_relay, chat_run

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


async def _seed_user(session: AsyncSession) -> str:
    uid = str(uuid.uuid4())
    email = f"g189-{uid[:8]}@example.com"
    await session.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.users (id,email,display_name) values (cast(:u as uuid),:e,'G189')"
        ),
        {"u": uid, "e": email},
    )
    await session.commit()
    return uid


async def _seed_thread(session: AsyncSession, *, owner: str) -> str:
    ws, proj, thread = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G189 WS')"
        ),
        {"w": ws, "u": owner},
    )
    await session.execute(
        text(
            "insert into public.workspace_memberships (workspace_id,user_id,role) "
            "values (cast(:w as uuid),cast(:u as uuid),'owner') on conflict do nothing"
        ),
        {"w": ws, "u": owner},
    )
    await session.execute(
        text(
            "insert into public.projects (id,workspace_id,name,project_type,status) "
            "values (cast(:p as uuid),cast(:w as uuid),'G189案件','client_work','active')"
        ),
        {"p": proj, "w": ws},
    )
    emp = str(uuid.uuid4())
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
            "values (cast(:t as uuid),cast(:p as uuid),cast(:e as uuid),'G189 スレッド')"
        ),
        {"t": thread, "p": proj, "e": emp},
    )
    await session.commit()
    return thread


async def _running_job(
    session: AsyncSession, *, owner: str, thread: str | None, body: str = ""
) -> str:
    job_id = await chat_relay.enqueue_job(
        session,
        thread_id=thread,
        requested_by=owner,
        system_prompt="SYS",
        prompt="PROMPT",
    )
    await session.execute(
        text("update public.chat_relay_jobs set status='running' where id = cast(:i as uuid)"),
        {"i": job_id},
    )
    if body:
        await chat_relay.append_chunks(session, job_id=job_id, seq_start=0, texts=[body])
    await session.commit()
    return job_id


class TestCancel:
    async def test_cancel_is_terminal_and_keeps_partial_text(self, session: AsyncSession) -> None:
        """止めても、そこまで書けた分は捨てない。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread, body="ここまで書けた")

        result = await chat_run.request_cancel(session, job_id=job, actor_id=uid)
        await session.commit()
        assert result.status == "cancelled"
        assert result.saved_chars > 0

        status = (
            await session.execute(
                text("select status from public.chat_relay_jobs where id = cast(:i as uuid)"),
                {"i": job},
            )
        ).scalar_one()
        assert status == "cancelled"

        saved = (
            await session.execute(
                text(
                    "select content from public.chat_messages "
                    "where thread_id = cast(:t as uuid) and role = 'assistant'"
                ),
                {"t": thread},
            )
        ).scalar_one()
        assert "ここまで書けた" in saved
        assert "中断" in saved  # 中断だと分かる印が本文に残る

    async def test_other_peoples_run_cannot_be_stopped(self, session: AsyncSession) -> None:
        """他人の PC で走っているものは止められない (R-T08 系の分離)。"""
        owner = await _seed_user(session)
        stranger = await _seed_user(session)
        thread = await _seed_thread(session, owner=owner)
        job = await _running_job(session, owner=owner, thread=thread)

        with pytest.raises(chat_run.RunControlError) as ei:
            await chat_run.request_cancel(session, job_id=job, actor_id=stranger)
        assert ei.value.code == "forbidden"

    async def test_already_finished_is_reported_not_faked(self, session: AsyncSession) -> None:
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread, body="完了")
        await chat_relay.complete_job(session, job_id=job, ok=True)
        await session.commit()

        result = await chat_run.request_cancel(session, job_id=job, actor_id=uid)
        assert result.status == "already_finished"

    async def test_bridge_can_read_the_stop_signal(self, session: AsyncSession) -> None:
        """Bridge がこれを読んで PC 上の claude を実際に止める。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread)

        assert await chat_run.cancel_requested(session, job_id=job) is False
        await chat_run.request_cancel(session, job_id=job, actor_id=uid)
        await session.commit()
        assert await chat_run.cancel_requested(session, job_id=job) is True

    async def test_unknown_job_is_treated_as_stop(self, session: AsyncSession) -> None:
        """消えたジョブを走らせ続ける理由は無い。"""
        assert await chat_run.cancel_requested(session, job_id=str(uuid.uuid4())) is True

    async def test_bridge_completing_a_cancelled_job_is_silent(self, session: AsyncSession) -> None:
        """停止処理を終えた Bridge の報告でエラーにしない・done で塗り替えない。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread, body="途中")
        await chat_run.request_cancel(session, job_id=job, actor_id=uid)
        await session.commit()

        await chat_relay.complete_job(session, job_id=job, ok=False, error="[cancelled]")
        await session.commit()
        status = (
            await session.execute(
                text("select status from public.chat_relay_jobs where id = cast(:i as uuid)"),
                {"i": job},
            )
        ).scalar_one()
        assert status == "cancelled"


class TestAnswerSurvivesAClosedBrowser:
    """GAP-189 の主眼: 返答の保存をブラウザからサーバーへ移す。"""

    async def test_completing_the_job_saves_the_answer(self, session: AsyncSession) -> None:
        """画面が繋がっていなくても、ジョブ確定でスレッドに答えが残る。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread, body="PC が書き上げた答え")

        # ブラウザ (SSE) は一切関与しない — Bridge の完了報告だけ
        await chat_relay.complete_job(session, job_id=job, ok=True)
        await session.commit()

        saved = (
            await session.execute(
                text(
                    "select content from public.chat_messages "
                    "where thread_id = cast(:t as uuid) and role = 'assistant'"
                ),
                {"t": thread},
            )
        ).scalar_one()
        assert saved == "PC が書き上げた答え"

    async def test_persisting_twice_does_not_duplicate(self, session: AsyncSession) -> None:
        """SSE 側と確定側の両方から呼ばれても二重投稿にならない。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread, body="1 回だけ")
        await chat_relay.complete_job(session, job_id=job, ok=True)
        await session.commit()

        again = await chat_run.persist_answer(session, job_id=job, thread_id=thread)
        await session.commit()
        assert again.created is False

        count = (
            await session.execute(
                text(
                    "select count(*) from public.chat_messages "
                    "where thread_id = cast(:t as uuid) and role = 'assistant'"
                ),
                {"t": thread},
            )
        ).scalar_one()
        assert int(count) == 1

    async def test_empty_answer_is_not_saved(self, session: AsyncSession) -> None:
        """空の吹き出しを並べない。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread)
        await chat_relay.complete_job(session, job_id=job, ok=True)
        await session.commit()
        count = (
            await session.execute(
                text(
                    "select count(*) from public.chat_messages "
                    "where thread_id = cast(:t as uuid) and role = 'assistant'"
                ),
                {"t": thread},
            )
        ).scalar_one()
        assert int(count) == 0

    async def test_tool_chatter_is_not_part_of_the_answer(self, session: AsyncSession) -> None:
        """ツール実況は本文ではない (混ぜない)。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread)
        await chat_relay.append_chunks(
            session,
            job_id=job,
            seq_start=0,
            texts=["Bash", "本文だけ"],
            kinds=["tool", "delta"],
        )
        await session.commit()
        assert await chat_run.assemble_answer(session, job_id=job) == "本文だけ"

    async def test_system_jobs_do_not_post_to_any_thread(self, session: AsyncSession) -> None:
        """モック生成等の thread 無しジョブは会話ではないので保存しない。"""
        uid = await _seed_user(session)
        job = await _running_job(session, owner=uid, thread=None, body="裏方の出力")
        await chat_relay.complete_job(session, job_id=job, ok=True)
        await session.commit()  # 例外を出さずに終わることが要件


class TestActiveRunAndReattach:
    async def test_active_run_is_found_for_the_owner_only(self, session: AsyncSession) -> None:
        uid = await _seed_user(session)
        stranger = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread)

        mine = await chat_run.active_run(session, thread_id=thread, actor_id=uid)
        assert mine is not None and mine.job_id == job
        assert await chat_run.active_run(session, thread_id=thread, actor_id=stranger) is None

    async def test_finished_run_is_not_active(self, session: AsyncSession) -> None:
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread, body="終わった")
        await chat_relay.complete_job(session, job_id=job, ok=True)
        await session.commit()
        assert await chat_run.active_run(session, thread_id=thread, actor_id=uid) is None

    async def test_snapshot_rejects_other_people(self, session: AsyncSession) -> None:
        uid = await _seed_user(session)
        stranger = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        job = await _running_job(session, owner=uid, thread=thread)
        with pytest.raises(chat_run.RunControlError) as ei:
            await chat_run.run_snapshot(session, job_id=job, actor_id=stranger)
        assert ei.value.code == "forbidden"


class TestQueuedInstructions:
    async def test_queued_instruction_is_saved_immediately(self, session: AsyncSession) -> None:
        """受け取った瞬間に保存する = ブラウザが落ちても消えない。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        await chat_run.queue_message(
            session, thread_id=thread, actor_id=uid, content="やっぱり色は青で"
        )
        await session.commit()

        items = await chat_run.list_queued(session, thread_id=thread, actor_id=uid)
        assert [i["content"] for i in items] == ["やっぱり色は青で"]

    async def test_consumed_in_order_and_only_once(self, session: AsyncSession) -> None:
        """同じ指示が 2 回流れない。順番も守る。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        for body in ("1 つ目", "2 つ目"):
            await chat_run.queue_message(session, thread_id=thread, actor_id=uid, content=body)
        await session.commit()

        first = await chat_run.consume_next(session, thread_id=thread, actor_id=uid)
        second = await chat_run.consume_next(session, thread_id=thread, actor_id=uid)
        third = await chat_run.consume_next(session, thread_id=thread, actor_id=uid)
        await session.commit()
        assert first is not None and first["content"] == "1 つ目"
        assert second is not None and second["content"] == "2 つ目"
        assert third is None

    async def test_other_people_cannot_see_or_consume(self, session: AsyncSession) -> None:
        uid = await _seed_user(session)
        stranger = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        await chat_run.queue_message(session, thread_id=thread, actor_id=uid, content="本人の指示")
        await session.commit()
        assert await chat_run.list_queued(session, thread_id=thread, actor_id=stranger) == []
        assert await chat_run.consume_next(session, thread_id=thread, actor_id=stranger) is None

    async def test_queue_can_be_dropped_before_it_runs(self, session: AsyncSession) -> None:
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        item = await chat_run.queue_message(
            session, thread_id=thread, actor_id=uid, content="気が変わった"
        )
        await session.commit()
        assert (
            await chat_run.drop_queued(
                session, thread_id=thread, queued_id=str(item["id"]), actor_id=uid
            )
            is True
        )
        await session.commit()
        assert await chat_run.list_queued(session, thread_id=thread, actor_id=uid) == []

    async def test_empty_instruction_is_rejected(self, session: AsyncSession) -> None:
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        with pytest.raises(chat_run.RunControlError) as ei:
            await chat_run.queue_message(session, thread_id=thread, actor_id=uid, content="   ")
        assert ei.value.code == "invalid_state"

    async def test_runaway_queue_is_capped(self, session: AsyncSession) -> None:
        """事故で無限に積まれるのを防ぐ。"""
        uid = await _seed_user(session)
        thread = await _seed_thread(session, owner=uid)
        for i in range(chat_run.MAX_QUEUED_PER_THREAD):
            await chat_run.queue_message(
                session, thread_id=thread, actor_id=uid, content=f"指示 {i}"
            )
        await session.commit()
        with pytest.raises(chat_run.RunControlError) as ei:
            await chat_run.queue_message(
                session, thread_id=thread, actor_id=uid, content="溢れる分"
            )
        assert ei.value.code == "too_many"
