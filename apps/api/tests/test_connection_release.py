"""GAP-201: 待っている間は DB 接続を手放す + その間も RLS は効いたまま。

**これまでの実態**:
    チャットの SSE は「本人の PC (Bridge) の実行待ち」の間ずっと、リクエストの
    DB 接続を 1 本掴んだままだった。長いと数分。そのため
    **同時に喋れる人数 = DB 接続の本数** になっていた (GAP-198 で実測)。

    加えて、role / claims は `set local` = transaction-local なので、
    リクエストの途中で commit するとその瞬間に消える。払い出し時に 1 回だけ
    入れていたため、**途中 commit の後に走る SQL は RLS 無し** (接続ロールのまま)
    だった — 待機中に接続を返す設計にすると、これがそのまま穴になる。

ここで固定する事実:
  - commit すると接続はプールへ返る (待っている間 0 本)
  - commit のあとも role / claims は貼り直され、RLS は効いたまま
  - SSE の本文は「start を出した直後に commit する」形になっている
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
from __future__ import annotations

import asyncio
import json
import os
import pathlib
from collections.abc import AsyncIterator

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
PG_URL = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
os.environ.setdefault("ATELIER_DB_URL", PG_URL)

from src.db.session import (  # noqa: E402 - env を先に立ててから読む
    DatabaseSettings,
    create_engine,
    create_session_factory,
    pool_stats,
)
from src.dependencies import _install_rls_guard  # noqa: E402

USER_ID = "11111111-1111-4111-8111-111111111111"
CLAIMS = json.dumps({"sub": USER_ID, "role": "authenticated"})


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


EngineAndFactory = tuple[AsyncEngine, async_sessionmaker[AsyncSession]]


@pytest.fixture
async def engine_and_factory() -> AsyncIterator[EngineAndFactory]:
    engine = create_engine(DatabaseSettings(url=PG_URL))
    yield engine, create_session_factory(engine)
    await engine.dispose()


class TestConnectionRelease:
    @pytest.mark.anyio
    async def test_commit_returns_the_connection_to_the_pool(
        self, engine_and_factory: EngineAndFactory
    ) -> None:
        """待っている間に接続を握り続けない (= 同時人数が接続数で決まらない)。"""
        engine, factory = engine_and_factory
        async with factory() as session:
            _install_rls_guard(session, CLAIMS)
            await session.execute(text("select 1"))
            assert pool_stats(engine).checked_out == 1

            await session.commit()  # 文脈構築が終わって「待ち」に入る
            assert pool_stats(engine).checked_out == 0

            await asyncio.sleep(0.05)  # 本人の PC の実行待ち (実際は数分)
            assert pool_stats(engine).checked_out == 0

            await session.execute(text("select 1"))  # 保存フェーズ
            assert pool_stats(engine).checked_out == 1
            await session.commit()

    @pytest.mark.anyio
    async def test_many_waiters_use_no_connections(
        self, engine_and_factory: EngineAndFactory
    ) -> None:
        """100 人が同時に待っていても接続は 0 本。"""
        engine, factory = engine_and_factory
        sessions = []
        try:
            for _ in range(100):
                s = factory()
                await s.__aenter__()
                _install_rls_guard(s, CLAIMS)
                await s.execute(text("select 1"))
                await s.commit()
                sessions.append(s)
            assert pool_stats(engine).checked_out == 0
        finally:
            for s in sessions:
                await s.__aexit__(None, None, None)


class TestRlsSurvivesCommit:
    @pytest.mark.anyio
    async def test_role_and_claims_are_reapplied_after_commit(
        self, engine_and_factory: EngineAndFactory
    ) -> None:
        """途中 commit のあとも RLS が効いていること (**ここが穴だった**)。"""
        _engine, factory = engine_and_factory
        async with factory() as session:
            _install_rls_guard(session, CLAIMS)

            before_claims = (
                await session.execute(text("select current_setting('request.jwt.claims', true)"))
            ).scalar()
            before_role = (await session.execute(text("select current_user"))).scalar()
            assert before_claims == CLAIMS
            assert str(before_role) == "authenticated"

            await session.commit()

            after_claims = (
                await session.execute(text("select current_setting('request.jwt.claims', true)"))
            ).scalar()
            after_role = (await session.execute(text("select current_user"))).scalar()
            assert after_claims == CLAIMS, "commit のあと claims が消えている"
            assert str(after_role) == "authenticated", "commit のあと role が戻ってしまっている"
            await session.commit()

    @pytest.mark.anyio
    async def test_without_the_guard_it_would_be_lost(
        self, engine_and_factory: EngineAndFactory
    ) -> None:
        """フックを入れない場合は消えること (回帰の意味を固定する)。"""
        _engine, factory = engine_and_factory
        async with factory() as session:
            await session.execute(
                text("select set_config('request.jwt.claims', :c, true)"), {"c": CLAIMS}
            )
            assert (
                await session.execute(text("select current_setting('request.jwt.claims', true)"))
            ).scalar() == CLAIMS
            await session.commit()
            assert (
                await session.execute(text("select current_setting('request.jwt.claims', true)"))
            ).scalar() == ""
            await session.commit()

    @pytest.mark.anyio
    async def test_rollback_also_reapplies(self, engine_and_factory: EngineAndFactory) -> None:
        """失敗して rollback したあとも RLS が戻ること。"""
        _engine, factory = engine_and_factory
        async with factory() as session:
            _install_rls_guard(session, CLAIMS)
            await session.execute(text("select 1"))
            await session.rollback()
            role = (await session.execute(text("select current_user"))).scalar()
            assert str(role) == "authenticated"
            await session.commit()


class TestStreamReleasesWhileWaiting:
    def test_sse_commits_right_after_start(self) -> None:
        """SSE 本文が「start を出した直後に commit する」形になっていること。"""
        src = (
            pathlib.Path(__file__).resolve().parents[1]
            / "src"
            / "services"
            / "chat_sse"
            / "__init__.py"
        ).read_text(encoding="utf-8")
        marker = 'yield _sse_event({"type": "start"})'
        assert marker in src
        after = src.split(marker, 1)[1]
        # start の直後 (待ちに入る前) に commit している。
        # 区切りは「次に何かを yield するまで」— 変数名を目印にすると、
        # 実装をいじった拍子に目印だけが消えてテストが壊れる (実際に踏んだ)。
        head = after[: after.index("yield ")]
        assert "await session.commit()" in head, "待ちに入る前に接続を手放していない"
