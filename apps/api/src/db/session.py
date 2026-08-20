"""DB engine / session factory。

asyncpg + SQLAlchemy 2.0 AsyncEngine。FastAPI Depends から get_session を呼んで
リクエストスコープの AsyncSession を取得する。

Supabase Postgres (Tokyo region) 接続。RLS は接続単位で session GUC を投入
(set_config('request.jwt.claim.sub', user_id, true)) して enforce する。

GAP-197 — **engine はプロセス (event loop) に 1 つ**:
    これまで各サービスが個別に `create_session_factory(create_engine())` を
    呼んでおり、**実測でプロセス内に AsyncEngine が 13 個**あった。
    1 engine あたり pool_size 10 + overflow 5 なので、最大で
    **195 接続/machine (2 台なら 390)** を要求しうる状態だった
    (docs には「1 台 15 接続」と書かれていた — 13 倍の誤り)。
    Supabase の接続上限を軽く超えるので、負荷がかかった時に初めて
    "too many connections" で落ちる。しかも今は**どれだけ使っているか
    見る手段が無い**。

    そこで:
      - `shared_session_factory()` に寄せて engine を 1 個にする
      - プールの実使用量を `pool_stats()` で見えるようにする
        (運営ヘルスチェックに出す — 測ってから増やす)
      - 接続予算 (`ATELIER_DB_CONNECTION_BUDGET`) を超える設定は起動時に警告する

    asyncpg の接続は event loop を跨げないため、キャッシュは loop 単位。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from functools import lru_cache
from typing import cast

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import QueuePool


class DatabaseSettings(BaseSettings):
    """環境変数から DB 設定を読む。`.env` および Vercel/Fly.io secrets と統合。"""

    model_config = SettingsConfigDict(
        env_prefix="ATELIER_DB_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    url: str = Field(
        description=(
            "postgresql+asyncpg://USER:PASSWORD@HOST:PORT/DBNAME — Supabase 接続文字列の asyncpg 版"
        ),
    )
    #: GAP-197: engine が 1 個になったので、1 プロセスの上限がそのままこの値になる。
    #: 20 + 10 = 30/machine、fly.toml の max_machines_running=2 で 60。
    pool_size: int = Field(default=20, ge=1, le=100)
    max_overflow: int = Field(default=10, ge=0, le=50)
    #: プール枯渇時の待ち時間。長すぎると「遅い」が「壊れている」に見えないので短め。
    pool_timeout: float = Field(default=10.0, gt=0)
    pool_recycle_seconds: int = Field(default=1800, ge=60)
    echo_sql: bool = Field(default=False)
    #: DB 側で許される接続数の予算 (全 machine 合計)。超える設定は起動時に警告する。
    connection_budget: int = Field(default=60, ge=1, le=10000)
    #: 同時に動きうる machine 数 (fly.toml の max_machines_running と揃える)。
    max_machines: int = Field(default=2, ge=1, le=100)


@lru_cache(maxsize=1)
def _settings() -> DatabaseSettings:
    return DatabaseSettings()  # type: ignore[call-arg]


def create_engine(settings: DatabaseSettings | None = None) -> AsyncEngine:
    """AsyncEngine を生成する。プロセスで 1 つだけ作る想定。"""
    cfg = settings or _settings()
    return create_async_engine(
        cfg.url,
        pool_size=cfg.pool_size,
        max_overflow=cfg.max_overflow,
        pool_timeout=cfg.pool_timeout,
        pool_recycle=cfg.pool_recycle_seconds,
        pool_pre_ping=True,
        echo=cfg.echo_sql,
        future=True,
    )


def create_session_factory(
    engine: AsyncEngine,
) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(
        bind=engine,
        expire_on_commit=False,
        class_=AsyncSession,
    )


@lru_cache(maxsize=8)
def _shared_engine_for_loop(loop_key: int) -> AsyncEngine:
    """event loop ごとに 1 つだけ engine を持つ。

    asyncpg の接続は event loop を跨げないので loop 単位で分ける。
    本番は loop が 1 つなので **プロセスに 1 engine** になる。
    """
    del loop_key  # cache key 専用
    return create_engine()


def shared_engine() -> AsyncEngine:
    """このプロセス (実行中 event loop) の共有 engine。

    **新しいコードは create_engine() を直接呼ばない**。呼ぶとプールが増える。
    """
    return _shared_engine_for_loop(id(asyncio.get_running_loop()))


def shared_session_factory() -> async_sessionmaker[AsyncSession]:
    """共有 engine に紐づく sessionmaker。

    RLS セッションも service セッションもこれを使ってよい。role / claims は
    いずれも `set local` (transaction-local) で入れているため、同じ接続を
    使い回しても設定が次の transaction へ漏れない。
    """
    return _shared_session_factory_for_loop(id(asyncio.get_running_loop()))


@lru_cache(maxsize=8)
def _shared_session_factory_for_loop(loop_key: int) -> async_sessionmaker[AsyncSession]:
    return create_session_factory(_shared_engine_for_loop(loop_key))


def reset_shared_engine_cache() -> None:
    """共有 engine のキャッシュを捨てる (**テスト専用**)。

    テストは block ごとに新しい event loop を作るため、前の loop に紐づいた
    engine を掴んだままにしないための出口。本番では呼ばない。
    """
    _shared_engine_for_loop.cache_clear()
    _shared_session_factory_for_loop.cache_clear()


@dataclass(frozen=True)
class PoolStats:
    """プールの実使用量 (推測ではなく SQLAlchemy が持っている実値)。"""

    #: 常設プールの大きさ (設定値)
    size: int
    #: 追加で開ける上限 (設定値)
    max_overflow: int
    #: いま貸し出し中 = 実際に使われている接続数
    checked_out: int
    #: プールに戻って待機している接続数 (実際に張られていて空いているもの)
    checked_in: int
    #: 常設ぶんを超えて開いている接続数
    overflow: int
    #: この engine が要求しうる最大接続数 (size + max_overflow)
    capacity: int
    #: 全 machine 合計の上限 (capacity × max_machines)
    fleet_capacity: int
    #: DB 側で許される接続数の予算
    budget: int

    @property
    def within_budget(self) -> bool:
        return self.fleet_capacity <= self.budget


def pool_stats(engine: AsyncEngine | None = None) -> PoolStats:
    """プールの実使用量を返す (運営ヘルスチェック用)。

    「足りているか」を**測ってから**増やすための数字。推測しない。
    """
    cfg = _settings()
    target = engine if engine is not None else shared_engine()
    # QueuePool だけが size()/checkedout()/overflow() を持つ (テストの NullPool は持たない)
    pool = cast("QueuePool", target.pool)
    size = int(pool.size())
    checked_out = int(pool.checkedout())
    checked_in = int(pool.checkedin())
    overflow = max(0, int(pool.overflow()))
    capacity = cfg.pool_size + cfg.max_overflow
    return PoolStats(
        size=size,
        max_overflow=cfg.max_overflow,
        checked_out=checked_out,
        checked_in=checked_in,
        overflow=overflow,
        capacity=capacity,
        fleet_capacity=capacity * cfg.max_machines,
        budget=cfg.connection_budget,
    )


def pool_capacity(settings: DatabaseSettings | None = None) -> int:
    """1 台が要求しうる最大接続数 (常設 + 追加)。

    SSE の同時接続上限 (GAP-198) はここから逆算する。
    """
    cfg = settings or _settings()
    return cfg.pool_size + cfg.max_overflow


def describe_pool_budget(settings: DatabaseSettings | None = None) -> tuple[str, bool]:
    """接続予算の説明文と「予算内か」を返す (起動ログ + 運営画面で使う)。"""
    cfg = settings or _settings()
    capacity = cfg.pool_size + cfg.max_overflow
    fleet = capacity * cfg.max_machines
    ok = fleet <= cfg.connection_budget
    text = (
        f"DB 接続: 1 台あたり最大 {capacity} "
        f"(常設 {cfg.pool_size} + 追加 {cfg.max_overflow}) × {cfg.max_machines} 台 "
        f"= 最大 {fleet} / 予算 {cfg.connection_budget}"
    )
    if not ok:
        text += " — **予算超過**。DB 側の上限に当たると接続エラーになります"
    return text, ok


@asynccontextmanager
async def get_session(
    factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[AsyncSession, None]:
    """リクエストスコープの AsyncSession。例外時は rollback、正常時は commit。"""
    async with factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()
