"""Unit tests for apps/api/src/audit/middleware.py."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditMiddleware


def _build_app(executions: list[Any], *, exempt: set[str] | None = None) -> FastAPI:
    """Audit middleware を載せた FastAPI を組み立てる helper。"""
    app = FastAPI()

    session = MagicMock(spec=AsyncSession)
    session.execute = AsyncMock(
        side_effect=lambda *args, **kwargs: executions.append((args, kwargs))
    )

    @asynccontextmanager
    async def factory():
        yield session

    if exempt is None:
        app.add_middleware(AuditMiddleware, session_factory=factory)
    else:
        app.add_middleware(AuditMiddleware, session_factory=factory, exempt_paths=exempt)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/projects")
    async def projects() -> dict[str, list[str]]:
        return {"items": []}

    return app


@pytest.mark.unit
class TestAuditMiddleware:
    @pytest.mark.asyncio
    async def test_health_is_exempt_by_default(self) -> None:
        executions: list[Any] = []
        app = _build_app(executions)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/health")
        assert response.status_code == 200
        assert executions == []

    @pytest.mark.asyncio
    async def test_normal_request_is_logged(self) -> None:
        executions: list[Any] = []
        app = _build_app(executions)
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/projects")
        assert response.status_code == 200
        assert len(executions) == 1
        _args, kwargs = executions[0]
        # 何らかの形で metadata に method/path が入る (SQL params)
        # SQLAlchemy text() は positional args で渡る場合があるので
        # 単に呼ばれたことだけを確認

    @pytest.mark.asyncio
    async def test_custom_exempt_paths(self) -> None:
        executions: list[Any] = []
        app = _build_app(executions, exempt={"/projects"})
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            await client.get("/projects")
        assert executions == []

    @pytest.mark.asyncio
    async def test_middleware_swallows_writer_failure(self) -> None:
        """audit 書込が落ちても response はそのまま返る (defense in depth)。"""
        app = FastAPI()

        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(side_effect=RuntimeError("DB down"))

        @asynccontextmanager
        async def factory():
            yield session

        app.add_middleware(AuditMiddleware, session_factory=factory)

        @app.get("/projects")
        async def projects() -> dict[str, str]:
            return {"status": "ok"}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/projects")
        # writer 失敗でも response は 200
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_middleware_swallows_session_factory_failure(self) -> None:
        """session factory が落ちても response はそのまま返る。"""
        app = FastAPI()

        @asynccontextmanager
        async def failing_factory():
            raise RuntimeError("session pool exhausted")
            yield  # type: ignore[unreachable]

        app.add_middleware(AuditMiddleware, session_factory=failing_factory)

        @app.get("/projects")
        async def projects() -> dict[str, str]:
            return {"status": "ok"}

        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/projects")
        assert response.status_code == 200
