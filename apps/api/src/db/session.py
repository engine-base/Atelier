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

    # ----------------------------------------------------------------- #
    # GAP-205: 3 台目の壁 (DB 接続) を **来てから慌てない**ようにする。
    #
    # 機械は 1 台 $2.02/月 で増やせるが、全部の機械が同じ Supabase を共有する。
    # 直結だと 1 台 30 接続 × 台数 が DB 側の上限に当たるため、**2 台で頭打ち**。
    # その先は Supabase の Supavisor (接続をまとめ役に集約する仕組み) を挟む。
    #
    # ここを **設定だけで切り替えられる**ようにしておく。混み始めてから
    # コードを直すのでは間に合わない。
    # ----------------------------------------------------------------- #

    #: Supavisor (transaction pooler) 経由か。未指定なら **接続文字列から自動判定**。
    #: 明示したいときは ATELIER_DB_POOLER_MODE=1 / 0。
    pooler_mode: bool | None = None
    #: pooler 経由のときの接続予算 (Supabase のプランで決まる。要確認)。
    pooler_connection_budget: int = Field(default=200, ge=1, le=100000)


#: Supavisor の接続文字列に必ず現れる印 (ホスト名 or transaction mode のポート)。
_POOLER_HINTS = ("pooler.supabase.com", ":6543")


def uses_pooler(settings: DatabaseSettings | None = None) -> bool:
    """Supavisor 経由で繋いでいるか。

    明示指定があればそれに従い、無ければ接続文字列から判定する
    (**繋ぎ先を変えたのに設定を変え忘れる**、を防ぐ)。
    """
    cfg = settings or _settings()
    if cfg.pooler_mode is not None:
        return cfg.pooler_mode
    return any(hint in cfg.url for hint in _POOLER_HINTS)


def connect_args_for(settings: DatabaseSettings | None = None) -> dict[str, object]:
    """接続時に渡す引数。

    **Supavisor の transaction mode では prepared statement が使えない**
    (接続が毎回別のものに割り当てられるため、前回作った文が見つからず
    `InvalidSQLStatementNameError` で落ちる)。asyncpg は既定で prepared
    statement を使うので、pooler 経由のときだけ無効にする。

    直結のときは無効にしない — 速度が落ちるだけで得が無いため。
    """
    if not uses_pooler(settings):
        return {}
    return {
        # 文のキャッシュを持たない (毎回その場で組み立てる)
        "statement_cache_size": 0,
        # SQLAlchemy が付ける名前付き prepared statement も止める
        "prepared_statement_cache_size": 0,
    }


@lru_cache(maxsize=1)
def _settings() -> DatabaseSettings:
    return DatabaseSettings()  # type: ignore[call-arg]


def create_engine(settings: DatabaseSettings | None = None) -> AsyncEngine:
    """AsyncEngine を生成する。プロセスで 1 つだけ作る想定。"""
    cfg = settings or _settings()
    return create_async_engine(
        cfg.url,
        connect_args=connect_args_for(cfg),
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
def _shared_engine_for_loop(loop: asyncio.AbstractEventLoop) -> AsyncEngine:
    """event loop ごとに 1 つだけ engine を持つ。

    asyncpg の接続は event loop を跨げないので loop 単位で分ける。
    本番は loop が 1 つなので **プロセスに 1 engine** になる。

    キーは **loop オブジェクトそのもの**。以前は `id(loop)` だったが、
    `id()` は死んだ loop の値が次の loop に再利用されるため、新しい loop が
    前の loop に紐づいた接続を持つ engine を掴み、次の SQL で
    `connection was closed in the middle of operation` になっていた
    (テスト全体実行で実際に踏んだ: cron の実行履歴 insert が静かに落ちていた)。
    オブジェクトをキーにすれば、キャッシュが生きている限り同じ id の別 loop は
    現れない。maxsize=8 は「engine (= 接続プール) を増やしすぎない」ための上限
    — 外すと loop を作るたびにプールが積み上がり、接続数の上限に当たる。
    """
    del loop  # cache key 専用
    return create_engine()


def shared_engine() -> AsyncEngine:
    """このプロセス (実行中 event loop) の共有 engine。

    **新しいコードは create_engine() を直接呼ばない**。呼ぶとプールが増える。
    """
    return _shared_engine_for_loop(asyncio.get_running_loop())


def shared_session_factory() -> async_sessionmaker[AsyncSession]:
    """共有 engine に紐づく sessionmaker。

    RLS セッションも service セッションもこれを使ってよい。role / claims は
    いずれも `set local` (transaction-local) で入れているため、同じ接続を
    使い回しても設定が次の transaction へ漏れない。
    """
    return _shared_session_factory_for_loop(asyncio.get_running_loop())


@lru_cache(maxsize=8)
def _shared_session_factory_for_loop(
    loop: asyncio.AbstractEventLoop,
) -> async_sessionmaker[AsyncSession]:
    return create_session_factory(_shared_engine_for_loop(loop))


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


def effective_budget(settings: DatabaseSettings | None = None) -> int:
    """今の繋ぎ方で使える接続予算。

    Supavisor 経由なら、まとめ役が肩代わりするぶん予算が増える。
    """
    cfg = settings or _settings()
    return cfg.pooler_connection_budget if uses_pooler(cfg) else cfg.connection_budget


def machines_supported(settings: DatabaseSettings | None = None) -> int:
    """**あと何台まで増やせるか** を予算から逆算する (GAP-205)。

    「増やしたいときに初めて壁を知る」を無くすための数字。
    機械 1 台は月 $2.02 で増やせるが、**DB 接続はそうはいかない**ので、
    そちらが先に頭打ちになることを常に見えるようにしておく。
    """
    cfg = settings or _settings()
    capacity = pool_capacity(cfg)
    if capacity <= 0:  # pragma: no cover - 設定上ありえないが 0 除算を避ける
        return cfg.max_machines
    return max(0, effective_budget(cfg) // capacity)


def describe_pool_budget(settings: DatabaseSettings | None = None) -> tuple[str, bool]:
    """接続予算の説明文と「予算内か」を返す (起動ログ + 運営画面で使う)。"""
    cfg = settings or _settings()
    capacity = pool_capacity(cfg)
    fleet = capacity * cfg.max_machines
    budget = effective_budget(cfg)
    ok = fleet <= budget
    route = "Supavisor 経由" if uses_pooler(cfg) else "直結"
    limit = machines_supported(cfg)
    text = (
        f"DB 接続 ({route}): 1 台あたり最大 {capacity} "
        f"(常設 {cfg.pool_size} + 追加 {cfg.max_overflow}) × {cfg.max_machines} 台 "
        f"= 最大 {fleet} / 予算 {budget}"
    )
    if not ok:
        text += " — **予算超過**。DB 側の上限に当たると接続エラーになります"
    elif limit <= cfg.max_machines:
        # GAP-205: **増やそうとした瞬間に壁がある**ことを、増やす前に知らせる。
        text += (
            f" — この予算で動かせるのは {limit} 台まで。"
            "これ以上 machine を増やすには Supavisor 経由へ切り替えが要ります"
            " (docs/scaling-runbook.md)"
        )
    else:
        text += f" — この予算なら {limit} 台まで増やせます"
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
