"""Unit tests for apps/api/src/db/session.py.

DatabaseSettings / create_engine / create_session_factory / get_session を
SQLite + aiosqlite を使ったローカル engine で検証する。

Coverage target: >= 80% lines for src/db/session.py.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from src.db import session as session_mod
from src.db.session import (
    DatabaseSettings,
    create_engine,
    create_session_factory,
    get_session,
)


@pytest.mark.unit
class TestDatabaseSettings:
    def test_defaults_when_url_provided_via_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_DB_URL", "postgresql+asyncpg://u:p@h:5432/db")
        cfg = DatabaseSettings()  # type: ignore[call-arg]
        assert cfg.url == "postgresql+asyncpg://u:p@h:5432/db"
        assert cfg.pool_size == 10
        assert cfg.max_overflow == 5
        assert cfg.pool_timeout == 30.0
        assert cfg.pool_recycle_seconds == 1800
        assert cfg.echo_sql is False

    def test_overrides_via_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_DB_URL", "postgresql+asyncpg://u:p@h/db")
        monkeypatch.setenv("ATELIER_DB_POOL_SIZE", "3")
        monkeypatch.setenv("ATELIER_DB_MAX_OVERFLOW", "1")
        monkeypatch.setenv("ATELIER_DB_POOL_TIMEOUT", "5.0")
        monkeypatch.setenv("ATELIER_DB_POOL_RECYCLE_SECONDS", "120")
        monkeypatch.setenv("ATELIER_DB_ECHO_SQL", "true")
        cfg = DatabaseSettings()  # type: ignore[call-arg]
        assert cfg.pool_size == 3
        assert cfg.max_overflow == 1
        assert cfg.pool_timeout == 5.0
        assert cfg.pool_recycle_seconds == 120
        assert cfg.echo_sql is True

    def test_pool_size_bounds(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_DB_URL", "postgresql+asyncpg://u:p@h/db")
        monkeypatch.setenv("ATELIER_DB_POOL_SIZE", "0")
        with pytest.raises(Exception):  # noqa: B017 - pydantic v2 ValidationError
            DatabaseSettings()  # type: ignore[call-arg]


@pytest.mark.unit
class TestCreateEngine:
    def test_returns_async_engine_with_provided_settings(self) -> None:
        cfg = DatabaseSettings(  # type: ignore[call-arg]
            url="postgresql+asyncpg://u:p@localhost:5432/test",
            pool_size=2,
            max_overflow=0,
            pool_timeout=1.0,
            pool_recycle_seconds=60,
            echo_sql=False,
        )
        engine = create_engine(cfg)
        try:
            assert isinstance(engine, AsyncEngine)
        finally:
            # sync dispose (avoid event loop dependency in this unit test)
            engine.sync_engine.dispose()

    def test_uses_cached_settings_when_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # _settings() is lru_cache'd. Inject env, clear cache, call.
        monkeypatch.setenv("ATELIER_DB_URL", "postgresql+asyncpg://u:p@localhost:5432/test")
        session_mod._settings.cache_clear()
        engine = create_engine()
        try:
            assert isinstance(engine, AsyncEngine)
        finally:
            engine.sync_engine.dispose()


@pytest.mark.unit
class TestCreateSessionFactory:
    def test_returns_async_sessionmaker(self) -> None:
        cfg = DatabaseSettings(  # type: ignore[call-arg]
            url="postgresql+asyncpg://u:p@localhost:5432/test",
        )
        engine = create_engine(cfg)
        try:
            factory = create_session_factory(engine)
            assert isinstance(factory, async_sessionmaker)
        finally:
            engine.sync_engine.dispose()


@pytest.mark.unit
class TestGetSession:
    @pytest.mark.asyncio
    async def test_commits_on_success(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.commit = AsyncMock()
        session.rollback = AsyncMock()
        session.close = AsyncMock()

        class FakeFactory:
            def __call__(self) -> Any:
                return _FakeCtx(session)

        ctx_mgr = get_session(FakeFactory())  # type: ignore[arg-type]
        async with ctx_mgr as s:
            assert s is session
        session.commit.assert_awaited_once()
        session.rollback.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_rolls_back_on_exception(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.commit = AsyncMock()
        session.rollback = AsyncMock()
        session.close = AsyncMock()

        class FakeFactory:
            def __call__(self) -> Any:
                return _FakeCtx(session)

        with pytest.raises(RuntimeError, match="boom"):
            async with get_session(FakeFactory()) as _:  # type: ignore[arg-type]
                raise RuntimeError("boom")
        session.rollback.assert_awaited_once()
        session.commit.assert_not_awaited()


class _FakeCtx:
    """async with でセッションを返す軽量フェイク。"""

    def __init__(self, session: Any) -> None:
        self._session = session

    async def __aenter__(self) -> Any:
        return self._session

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        return None
