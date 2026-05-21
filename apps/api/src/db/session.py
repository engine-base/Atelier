"""DB engine / session factory。

asyncpg + SQLAlchemy 2.0 AsyncEngine。FastAPI Depends から get_session を呼んで
リクエストスコープの AsyncSession を取得する。

Supabase Postgres (Tokyo region) 接続。RLS は接続単位で session GUC を投入
(set_config('request.jwt.claim.sub', user_id, true)) して enforce する。
T-D-22 (R-T08 RLS) で具体的な claim 注入ヘルパを追加する。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


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
            "postgresql+asyncpg://USER:PASSWORD@HOST:PORT/DBNAME"
            " — Supabase 接続文字列の asyncpg 版"
        ),
    )
    pool_size: int = Field(default=10, ge=1, le=100)
    max_overflow: int = Field(default=5, ge=0, le=50)
    pool_timeout: float = Field(default=30.0, gt=0)
    pool_recycle_seconds: int = Field(default=1800, ge=60)
    echo_sql: bool = Field(default=False)


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


@asynccontextmanager
async def get_session(
    factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[AsyncSession]:
    """リクエストスコープの AsyncSession。例外時は rollback、正常時は commit。"""
    async with factory() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()
