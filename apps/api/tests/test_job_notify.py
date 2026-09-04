"""GAP-202: 「届いた？」と聞きに行くのをやめ、届いた瞬間に知らせてもらう。

**これまでの実態**:
    チャットが本人の PC (Bridge) の実行を待っている間、サーバーは 0.25 秒ごとに
    DB へ 3 クエリを投げ続けていた。AI の計算は利用者の PC で動いているのに、
    **「届いた？」と聞き続ける部分だけで同時人数の上限が決まっていた**。

ここで固定する事実:
  - trigger が chunk / 状態 / 承認の書き込みで通知を出す (経路を増やしても漏れない)
  - 通知は **commit したときに** 届く (まだ読めないのに起こされない)
  - **関係ない人は起きない** (自分のジョブの通知だけ受ける)
  - 大量の chunk を 1 トランザクションで入れても通知は 1 通 (畳まれる)
  - 待ち受けが張れないときは**従来のポーリング間隔へ戻る** (黙って固まらない)
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
# 実 PG の場所は環境で違う (CI は TCP、手元の検証環境は unix socket)。
# 決め打ちすると CI で「Postgres not available」= 全 skip になり、
# **配線が切れているのに緑**という一番危ない状態になる (Gate #14 の skip ガード)。
PG_URL = (
    os.environ.get("ATELIER_TEST_PG_URL")
    or os.environ.get("ATELIER_DB_URL")
    or "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
os.environ.setdefault("ATELIER_DB_URL", PG_URL)

from src.db import notify as db_notify  # noqa: E402 - env を先に立ててから読む
from src.db.session import (  # noqa: E402
    DatabaseSettings,
    create_engine,
    create_session_factory,
)


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_URL.replace("+asyncpg", "+psycopg"), poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")

Factory = async_sessionmaker[AsyncSession]


@asynccontextmanager
async def live_env() -> AsyncGenerator[tuple[db_notify.JobNotifier, Factory]]:
    """待ち受け接続と session factory を **テストと同じ event loop で** 作る。

    async fixture にすると fixture 側とテスト側で loop が分かれ、asyncpg の
    通知コールバックがテスト中に回らない (実際に踏んだ)。
    """
    settings = DatabaseSettings(url=PG_URL)
    engine = create_engine(settings)
    notifier = db_notify.JobNotifier(dsn=db_notify.listen_dsn(settings))
    assert await notifier.start(), "LISTEN 接続が張れなかった"
    try:
        yield notifier, create_session_factory(engine)
    finally:
        await notifier.close()
        await engine.dispose()


async def _pg_notify(factory: Factory, job_id: str) -> None:
    """trigger を通さずに配達だけ試す。"""
    async with factory() as session:
        await session.execute(
            text("select pg_notify(:ch, :p)"), {"ch": db_notify.CHANNEL, "p": job_id}
        )
        await session.commit()


async def _seed_job(factory: Factory, job_id: str) -> None:
    """ジョブ 1 件を実 DB に作る (auth.users → users → job の順に FK を満たす)。"""
    user_id = str(uuid.uuid4())
    async with factory() as session:
        await session.execute(
            text("insert into auth.users (id) values (cast(:u as uuid))"),
            {"u": user_id},
        )
        await session.execute(
            text("insert into public.users (id, email) values (cast(:u as uuid), :e)"),
            {"u": user_id, "e": f"{user_id}@example.test"},
        )
        await session.execute(
            text(
                "insert into public.chat_relay_jobs "
                "(id, requested_by, system_prompt, prompt, status) "
                "values (cast(:j as uuid), cast(:u as uuid), 'sys', 'p', 'running')"
            ),
            {"j": job_id, "u": user_id},
        )
        await session.commit()


class TestDelivery:
    @pytest.mark.anyio
    async def test_waiter_wakes_on_notify(self) -> None:
        """自分のジョブに動きがあったら起きる。"""
        async with live_env() as (notifier, factory):
            job_id = str(uuid.uuid4())
            with notifier.subscribe(job_id) as wake:
                wake.clear()  # 購読直後の「1 回目は待たない」ぶんを消す
                await _pg_notify(factory, job_id)
                assert await notifier.wait(wake, timeout=5.0) is True

    @pytest.mark.anyio
    async def test_other_jobs_do_not_wake(self) -> None:
        """**関係ない人は起きない** — ここが崩れると全員が毎回起きる。"""
        async with live_env() as (notifier, factory):
            mine, other = str(uuid.uuid4()), str(uuid.uuid4())
            with notifier.subscribe(mine) as wake:
                wake.clear()
                await _pg_notify(factory, other)
                assert await notifier.wait(wake, timeout=0.5) is False

    @pytest.mark.anyio
    async def test_first_wait_returns_immediately(self) -> None:
        """購読前に書き込まれていたぶんを取りこぼさないよう 1 回目は待たない。"""
        async with live_env() as (notifier, _factory):
            with notifier.subscribe(str(uuid.uuid4())) as wake:
                assert await notifier.wait(wake, timeout=5.0) is True

    @pytest.mark.anyio
    async def test_subscription_is_removed_on_exit(self) -> None:
        """抜けたら登録が残らない (待っている人数が漏れて増えない)。"""
        async with live_env() as (notifier, _factory):
            with notifier.subscribe(str(uuid.uuid4())):
                assert notifier.stats().waiting == 1
            assert notifier.stats().waiting == 0


class TestDegraded:
    """待ち受けが使えないときも**止まらない**こと。"""

    @pytest.mark.anyio
    async def test_recheck_interval_falls_back_when_disconnected(self) -> None:
        dead = db_notify.JobNotifier(dsn="")
        assert dead.connected is False
        assert dead.recheck_interval() == db_notify.DEGRADED_RECHECK_SECONDS
        with dead.subscribe("j") as wake:
            wake.clear()
            # 通知は来ないが、必ず timeout で起きる (False = 保険で起きた)
            assert await dead.wait(wake, timeout=0.05) is False

    @pytest.mark.anyio
    async def test_bad_dsn_does_not_raise(self) -> None:
        """待ち受けが張れなくてもチャットは動く (例外にしない)。"""
        n = db_notify.JobNotifier(dsn="postgresql://nobody@127.0.0.1:1/none")
        assert await n.start() is False
        assert n.connected is False
        assert n.stats().last_error is not None
        await n.close()

    @pytest.mark.anyio
    async def test_healthy_interval_is_used_when_connected(self) -> None:
        """繋がっているときは保険の間隔まで寝る (毎秒 4 回叩かない)。"""
        async with live_env() as (notifier, _factory):
            assert notifier.connected is True
            assert notifier.recheck_interval() == db_notify.HEALTHY_RECHECK_SECONDS


class TestTriggers:
    """**アプリではなく DB の trigger** が通知を出していること。"""

    @pytest.mark.anyio
    async def test_chunk_insert_notifies(self) -> None:
        async with live_env() as (notifier, factory):
            job_id = str(uuid.uuid4())
            await _seed_job(factory, job_id)
            with notifier.subscribe(job_id) as wake:
                wake.clear()
                async with factory() as session:
                    await session.execute(
                        text(
                            "insert into public.chat_relay_chunks "
                            "(job_id, seq, content, kind) "
                            "values (cast(:j as uuid), 0, 'hello', 'delta')"
                        ),
                        {"j": job_id},
                    )
                    await session.commit()
                assert await notifier.wait(wake, timeout=5.0) is True

    @pytest.mark.anyio
    async def test_notify_arrives_only_after_commit(self) -> None:
        """**まだ読めないのに起こされない** (commit 前は届かない)。"""
        async with live_env() as (notifier, factory):
            job_id = str(uuid.uuid4())
            await _seed_job(factory, job_id)
            with notifier.subscribe(job_id) as wake:
                wake.clear()
                async with factory() as session:
                    await session.execute(
                        text(
                            "insert into public.chat_relay_chunks "
                            "(job_id, seq, content, kind) "
                            "values (cast(:j as uuid), 0, 'hello', 'delta')"
                        ),
                        {"j": job_id},
                    )
                    # commit していないので、まだ起きてはいけない
                    assert await notifier.wait(wake, timeout=0.5) is False
                    await session.commit()
                assert await notifier.wait(wake, timeout=5.0) is True

    @pytest.mark.anyio
    async def test_many_chunks_in_one_transaction_send_one_notify(self) -> None:
        """20 行まとめて入れても通知は 1 通 (Postgres が畳む)。"""
        async with live_env() as (notifier, factory):
            job_id = str(uuid.uuid4())
            await _seed_job(factory, job_id)
            with notifier.subscribe(job_id) as wake:
                wake.clear()
                before = notifier.stats().delivered
                async with factory() as session:
                    for seq in range(20):
                        await session.execute(
                            text(
                                "insert into public.chat_relay_chunks "
                                "(job_id, seq, content, kind) "
                                "values (cast(:j as uuid), :s, 'x', 'delta')"
                            ),
                            {"j": job_id, "s": seq},
                        )
                    await session.commit()
                assert await notifier.wait(wake, timeout=5.0) is True
                await asyncio.sleep(0.2)  # 追加で届くものがあれば拾う
                assert notifier.stats().delivered - before == 1

    @pytest.mark.anyio
    async def test_status_change_notifies(self) -> None:
        async with live_env() as (notifier, factory):
            job_id = str(uuid.uuid4())
            await _seed_job(factory, job_id)
            with notifier.subscribe(job_id) as wake:
                wake.clear()
                async with factory() as session:
                    await session.execute(
                        text(
                            "update public.chat_relay_jobs set status = 'done' "
                            "where id = cast(:j as uuid)"
                        ),
                        {"j": job_id},
                    )
                    await session.commit()
                assert await notifier.wait(wake, timeout=5.0) is True

    @pytest.mark.anyio
    async def test_unrelated_update_does_not_notify(self) -> None:
        """status が変わらない更新では起こさない (無駄に全員起こさない)。"""
        async with live_env() as (notifier, factory):
            job_id = str(uuid.uuid4())
            await _seed_job(factory, job_id)
            with notifier.subscribe(job_id) as wake:
                wake.clear()
                async with factory() as session:
                    await session.execute(
                        text(
                            "update public.chat_relay_jobs set result_error = 'note' "
                            "where id = cast(:j as uuid)"
                        ),
                        {"j": job_id},
                    )
                    await session.commit()
                assert await notifier.wait(wake, timeout=0.5) is False

    @pytest.mark.anyio
    async def test_approval_insert_and_decision_notify(self) -> None:
        """承認カードの発行と、その決着の両方で起きる。"""
        async with live_env() as (notifier, factory):
            job_id = str(uuid.uuid4())
            approval_id = str(uuid.uuid4())
            await _seed_job(factory, job_id)
            with notifier.subscribe(job_id) as wake:
                wake.clear()
                async with factory() as session:
                    await session.execute(
                        text(
                            "insert into public.chat_relay_approvals "
                            "(id, job_id, tool, summary, decision) "
                            "values (cast(:a as uuid), cast(:j as uuid), "
                            "'Bash', 'ls', 'pending')"
                        ),
                        {"a": approval_id, "j": job_id},
                    )
                    await session.commit()
                assert await notifier.wait(wake, timeout=5.0) is True

                wake.clear()
                async with factory() as session:
                    await session.execute(
                        text(
                            "update public.chat_relay_approvals set decision = 'allow' "
                            "where id = cast(:a as uuid)"
                        ),
                        {"a": approval_id},
                    )
                    await session.commit()
                assert await notifier.wait(wake, timeout=5.0) is True


class TestRelayUsesNotifier:
    def test_relay_no_longer_sleeps_on_a_fixed_interval(self) -> None:
        """SSE 本体が固定間隔の sleep をやめて通知待ちになっていること。"""
        import pathlib

        src = (
            pathlib.Path(__file__).resolve().parents[1]
            / "src"
            / "services"
            / "chat_sse"
            / "relay.py"
        ).read_text(encoding="utf-8")
        assert "_POLL_INTERVAL_SECONDS" not in src, "固定間隔のポーリングが残っている"
        assert "notifier.wait(wake)" in src, "通知待ちになっていない"
