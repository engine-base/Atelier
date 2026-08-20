"""DB 接続層。

- asyncpg を driver に、SQLAlchemy 2.0 Core で型安全 SQL ビルダーを使う。
- ORM 層は薄く、必要時に raw SQL も許容（03_architecture/selected-stack.json）。
- スキーマ定義は T-F-10 (Drizzle / TS 側) と T-D-01〜 (SQL migration / Supabase CLI)
  が信頼源。Python 側は SQLAlchemy reflection か手書き Table で必要なものだけ宣言する。
"""

from .base import Base, metadata
from .session import (
    DatabaseSettings,
    PoolStats,
    create_engine,
    create_session_factory,
    describe_pool_budget,
    get_session,
    pool_stats,
    reset_shared_engine_cache,
    shared_engine,
    shared_session_factory,
)

__all__ = [
    "Base",
    "DatabaseSettings",
    "PoolStats",
    "create_engine",
    "create_session_factory",
    "describe_pool_budget",
    "get_session",
    "metadata",
    "pool_stats",
    "reset_shared_engine_cache",
    "shared_engine",
    "shared_session_factory",
]
