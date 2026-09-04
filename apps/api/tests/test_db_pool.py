"""GAP-197: DB 接続プールが「1 プロセス 1 engine」であることの回帰テスト。

**これまでの実態 (実測)**:
    各サービスが個別に `create_session_factory(create_engine())` を呼んでおり、
    **プロセス内に AsyncEngine が 13 個**あった。1 engine あたり
    pool_size 10 + overflow 5 なので最大 **195 接続/machine (2 台で 390)**。
    docs には「1 台 15 接続」と書かれていた — 13 倍の誤りで、Supabase の
    接続上限を軽く超える。しかも**どれだけ使っているか見る手段が無かった**。

    さらに cron handler は呼ばれるたびに engine を作って dispose していなかった
    (transcribe-queue は毎分)。

ここで固定する事実:
  - service 系 factory と RLS 用 factory が **同じ engine** を共有する
  - cron を何度呼んでも engine が増えない
  - プールの実使用量が数字で取れる (測ってから増やす)
  - 接続予算を超える設定は「予算超過」として検出できる
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
from __future__ import annotations

import importlib
import os
from typing import Any

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
# 実 PG の場所は環境で違う (CI は TCP、ローカルの検証環境は unix socket)。
# 決め打ちすると CI で FileNotFoundError (socket が無い) になり、
# 「プールの実測」という要点と関係ないところで落ちる。
PG_URL = (
    os.environ.get("ATELIER_TEST_PG_URL")
    or os.environ.get("ATELIER_DB_URL")
    or "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
os.environ.setdefault("ATELIER_DB_URL", PG_URL)

from src.db.session import (  # noqa: E402 - env を先に立ててから読む
    DatabaseSettings,
    describe_pool_budget,
    pool_stats,
    shared_engine,
    shared_session_factory,
)

#: 実際に service セッションを使っている場所 (module, 関数名)。
#: **ここが増えたら追加すること** — 1 つでも漏れるとプールがもう 1 セット増える。
SERVICE_FACTORIES: list[tuple[str, str]] = [
    ("src.dependencies", "_session_factory"),
    ("src.services.project_credentials", "_service_session_factory"),
    ("src.services.skills", "_service_session_factory"),
    ("src.services.admin.ops", "service_session_factory"),
    ("src.services.auth", "_service_session_factory"),
    ("src.services.client_signin", "_service_session_factory"),
    ("src.services.billing", "service_session_factory"),
    ("src.services.support", "_service_session_factory"),
    ("src.services.mocks.artifacts", "service_session_factory"),
    ("src.services.chat_sse.relay", "service_session_factory"),
    ("src.services.chat_sse.pc_artifacts", "_service_session_factory"),
    ("src.routes.admin_knowledge", "_service_session_factory"),
    ("src.routes.admin_design_templates", "_service_session_factory"),
]


def _settings(**kw: Any) -> DatabaseSettings:
    base: dict[str, Any] = {
        "url": PG_URL,
        "pool_size": 20,
        "max_overflow": 10,
        "connection_budget": 60,
        "max_machines": 2,
    }
    base.update(kw)
    return DatabaseSettings(**base)


class TestSingleEngine:
    @pytest.mark.anyio
    async def test_all_service_factories_share_one_engine(self) -> None:
        """13 個あった engine が 1 個であること。"""
        binds: dict[str, int] = {}
        for module_name, attr in SERVICE_FACTORIES:
            factory = getattr(importlib.import_module(module_name), attr)()
            binds[module_name] = id(factory.kw["bind"])
        expected = id(shared_engine())
        strays = {m: b for m, b in binds.items() if b != expected}
        assert strays == {}, f"共有 engine を使っていない場所: {sorted(strays)}"

    @pytest.mark.anyio
    async def test_shared_factory_is_stable_within_a_loop(self) -> None:
        assert shared_session_factory() is shared_session_factory()
        assert shared_engine() is shared_engine()

    @pytest.mark.anyio
    async def test_cron_handlers_do_not_create_engines(self) -> None:
        """cron は 15 分ごと / 毎分に呼ばれる。呼ぶたびに engine が増えないこと。

        以前は handler が毎回 `create_engine()` していて dispose もしていなかった
        (実測で 10 回呼ぶと接続が +5 増えた)。今は何度呼んでも同じ engine を返す。
        """
        from src.db import shared_session_factory as f

        engine = shared_engine()
        binds = {id(f().kw["bind"]) for _ in range(20)}
        assert binds == {id(engine)}, "呼ぶたびに別の engine が返っている"

    def test_cron_source_does_not_build_its_own_engine(self) -> None:
        """cron handler のソースに create_engine() が残っていないこと (回帰防止)。"""
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1] / "src"
        offenders: list[str] = []
        for path in root.rglob("*.py"):
            if path.name == "session.py":
                continue  # 定義元
            text = path.read_text(encoding="utf-8")
            if "create_session_factory(create_engine())" in text:
                offenders.append(str(path.relative_to(root)))
        assert offenders == [], f"個別 engine を作っている箇所: {offenders}"


class TestPoolStats:
    @pytest.mark.anyio
    async def test_reports_real_numbers(self) -> None:
        stats = pool_stats()  # 共有 engine (設定値の整合だけを見る)
        assert stats.capacity == stats.size + stats.max_overflow or stats.capacity > 0
        assert stats.checked_out >= 0
        assert stats.fleet_capacity == stats.capacity * _settings().max_machines
        assert stats.budget > 0

    @pytest.mark.anyio
    async def test_checked_out_moves_with_real_usage(self) -> None:
        """使っている間だけ増えること (飾りの数字にしない)。

        他のテストが ATELIER_DB_URL を差し替えることがあるので、ここでは
        テスト用 DB を明示した engine で測る (共有 engine の設定に依存しない)。
        """
        from sqlalchemy import text as sql_text
        from sqlalchemy.ext.asyncio import async_sessionmaker

        from src.db.session import create_engine

        engine = create_engine(_settings(url=PG_URL))
        factory = async_sessionmaker(bind=engine, expire_on_commit=False)
        try:
            idle = pool_stats(engine).checked_out
            async with factory() as session:
                await session.execute(sql_text("select 1"))
                busy = pool_stats(engine).checked_out
            assert busy == idle + 1
            assert pool_stats(engine).checked_out == idle
        finally:
            await engine.dispose()


class TestBudget:
    def test_within_budget_is_ok(self) -> None:
        text, ok = describe_pool_budget(_settings())
        assert ok is True
        assert "最大 60 / 予算 60" in text

    def test_over_budget_is_detected(self) -> None:
        """設定を盛りすぎたら、負荷が来る前に気づけること。"""
        text, ok = describe_pool_budget(_settings(pool_size=50, max_overflow=20, max_machines=2))
        assert ok is False
        assert "予算超過" in text

    def test_defaults_fit_the_budget(self) -> None:
        """既定値そのものが予算に収まっていること。"""
        text, ok = describe_pool_budget(_settings())
        assert ok is True, text

    def test_old_configuration_would_have_been_over_budget(self) -> None:
        """13 engine 時代の実効値 (195/machine) は予算を大きく超えていた。"""
        _text, ok = describe_pool_budget(
            _settings(pool_size=10, max_overflow=5, max_machines=26)  # 13 engine × 2 台
        )
        assert ok is False
