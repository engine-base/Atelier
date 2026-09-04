"""GAP-205: **増やそうとした瞬間に壁を知る**、を無くす。

**これまでの実態**:
    機械 (Fly.io) は 1 台 月 $2.02 で増やせる。しかし全部の機械が同じ
    Supabase を共有していて、直結だと 1 台 30 接続 × 台数 が DB 側の上限に
    当たる。予算 60 = **ちょうど 2 台分**なので、3 台目で必ず失敗する。
    その事実は起動ログの数字を読み解かないと分からず、**増やそうとした
    その日に初めて気づく**状態だった。

ここで固定する事実:
  - 今の繋ぎ方で **何台まで増やせるか** が数字で出る
  - 繋ぎ先を Supavisor に変えたら、**設定を変え忘れても自動で気づく**
  - Supavisor 経由では prepared statement を無効にする
    (transaction mode では毎回別の接続に割り当てられ、前回の文が見つからない)
  - 直結のときは無効にしない (速度が落ちるだけで得が無い)
"""

from __future__ import annotations

import os

import pytest

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

from src.db.session import (  # noqa: E402 - env を先に立ててから読む
    DatabaseSettings,
    connect_args_for,
    describe_pool_budget,
    effective_budget,
    machines_supported,
    uses_pooler,
)

DIRECT = "postgresql+asyncpg://u:p@db.abcdefgh.supabase.co:5432/postgres"
POOLED = "postgresql+asyncpg://u:p@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres"


def _cfg(**kw: object) -> DatabaseSettings:
    return DatabaseSettings(**{"url": DIRECT, **kw})  # type: ignore[arg-type]


class TestPoolerDetection:
    def test_direct_connection_is_not_pooled(self) -> None:
        assert uses_pooler(_cfg()) is False

    def test_pooler_host_is_detected(self) -> None:
        """**繋ぎ先を変えたのに設定を変え忘れる**、を防ぐ (URL から自動判定)。"""
        assert uses_pooler(_cfg(url=POOLED)) is True

    def test_transaction_mode_port_is_detected(self) -> None:
        """ホスト名が違っても transaction mode のポートで気づく。"""
        assert uses_pooler(_cfg(url="postgresql+asyncpg://u:p@example.test:6543/postgres")) is True

    def test_explicit_setting_wins(self) -> None:
        """自動判定が外れる構成のために、明示指定を優先する。"""
        assert uses_pooler(_cfg(url=POOLED, pooler_mode=False)) is False
        assert uses_pooler(_cfg(url=DIRECT, pooler_mode=True)) is True


class TestConnectArgs:
    def test_pooler_disables_prepared_statements(self) -> None:
        """transaction mode では prepared statement が使えない。

        毎回別の接続に割り当てられるので、前回作った文が見つからず
        `InvalidSQLStatementNameError` で落ちる。asyncpg は既定で使うため、
        **pooler のときだけ**無効にする。
        """
        args = connect_args_for(_cfg(url=POOLED))
        assert args["statement_cache_size"] == 0
        assert args["prepared_statement_cache_size"] == 0

    def test_direct_keeps_prepared_statements(self) -> None:
        """直結では無効にしない (速度が落ちるだけで得が無い)。"""
        assert connect_args_for(_cfg()) == {}


class TestHeadroom:
    def test_direct_budget_allows_two_machines(self) -> None:
        """今の既定は **ちょうど 2 台分**。3 台目は必ず失敗する。"""
        cfg = _cfg(pool_size=20, max_overflow=10, connection_budget=60)
        assert effective_budget(cfg) == 60
        assert machines_supported(cfg) == 2

    def test_pooler_budget_allows_more(self) -> None:
        """Supavisor 経由なら、まとめ役が肩代わりするぶん増やせる。"""
        cfg = _cfg(url=POOLED, pool_size=20, max_overflow=10, pooler_connection_budget=200)
        assert effective_budget(cfg) == 200
        assert machines_supported(cfg) == 6

    def test_warns_before_you_try_to_add_a_machine(self) -> None:
        """**増やす前に**「ここまで」と書いてある (増やした日に知るのを無くす)。"""
        text, ok = describe_pool_budget(
            _cfg(pool_size=20, max_overflow=10, connection_budget=60, max_machines=2)
        )
        assert ok is True, "2 台なら予算内のはず"
        assert "2 台まで" in text
        assert "Supavisor" in text
        assert "scaling-runbook" in text

    def test_says_how_much_room_is_left_when_there_is_room(self) -> None:
        cfg = _cfg(
            url=POOLED,
            pool_size=20,
            max_overflow=10,
            pooler_connection_budget=200,
            max_machines=2,
        )
        text, ok = describe_pool_budget(cfg)
        assert ok is True
        assert "6 台まで増やせます" in text
        assert "Supavisor 経由" in text

    def test_over_budget_is_reported_as_such(self) -> None:
        """予算を超える設定は、起動時にはっきり分かる。"""
        text, ok = describe_pool_budget(
            _cfg(pool_size=20, max_overflow=10, connection_budget=60, max_machines=3)
        )
        assert ok is False
        assert "予算超過" in text


class TestRunbookExists:
    def test_runbook_is_present_and_actionable(self) -> None:
        """説明文が案内する手順書が実在すること (リンク切れにしない)。"""
        import pathlib

        runbook = pathlib.Path(__file__).resolve().parents[3] / "docs" / "scaling-runbook.md"
        assert runbook.exists(), "docs/scaling-runbook.md が無い"
        body = runbook.read_text(encoding="utf-8")
        # 手順書として最低限「何を変えるか」が書かれていること
        for needle in ("ATELIER_DB_POOLER_MODE", "ATELIER_DB_LISTEN_URL", "max_machines_running"):
            assert needle in body, f"手順書に {needle} の記載が無い"


@pytest.mark.anyio
async def test_prepared_statements_off_still_works_against_real_pg() -> None:
    """**実 Postgres で** prepared statement 無効のまま動くことを確かめる。

    Supavisor 本体は実 Supabase でしか試せないが、「その設定で SQL が通るか」
    はここで確かめられる。落ちるなら切替当日ではなく今 気づきたい。
    """
    import sqlalchemy
    from sqlalchemy import text
    from sqlalchemy.pool import NullPool

    try:
        probe = sqlalchemy.create_engine(PG_URL.replace("+asyncpg", "+psycopg"), poolclass=NullPool)
        with probe.connect() as c:
            c.execute(text("select 1"))
        probe.dispose()
    except Exception:
        pytest.skip("local Postgres not available")

    from src.db.session import create_engine, create_session_factory

    cfg = DatabaseSettings(url=PG_URL, pooler_mode=True)  # type: ignore[call-arg]
    assert connect_args_for(cfg)["statement_cache_size"] == 0
    engine = create_engine(cfg)
    try:
        factory = create_session_factory(engine)
        async with factory() as session:
            # パラメータ付き = 本来 prepared statement になるところ
            got = (await session.execute(text("select cast(:n as int) + 1"), {"n": 41})).scalar()
            assert got == 42
            # 同じ文を繰り返しても壊れない (キャッシュ無効でも再実行できる)
            for _ in range(3):
                assert (
                    await session.execute(text("select cast(:n as int) + 1"), {"n": 41})
                ).scalar() == 42
            await session.commit()
    finally:
        await engine.dispose()
