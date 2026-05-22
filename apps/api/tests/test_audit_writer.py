"""Unit tests for apps/api/src/audit/writer.py."""

from __future__ import annotations

import dataclasses
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter


@pytest.mark.unit
class TestAuditEvent:
    def test_minimum_construction(self) -> None:
        event = AuditEvent(action="auth.signin")
        assert event.action == "auth.signin"
        assert event.actor_id is None
        assert event.metadata == {}

    def test_frozen(self) -> None:
        event = AuditEvent(action="x")
        with pytest.raises(dataclasses.FrozenInstanceError):
            event.action = "y"  # type: ignore[misc]

    def test_metadata_default_is_independent(self) -> None:
        a = AuditEvent(action="a")
        b = AuditEvent(action="b")
        a.metadata["k"] = "v"
        assert "k" not in b.metadata

    def test_full_event(self) -> None:
        event = AuditEvent(
            action="project.update",
            actor_id="usr_123",
            resource_type="project",
            resource_id="prj_456",
            metadata={"diff": {"name": "old → new"}},
            ip="1.2.3.4",
            user_agent="curl/8",
            status_code=200,
        )
        assert event.resource_id == "prj_456"
        assert event.metadata == {"diff": {"name": "old → new"}}


@pytest.mark.unit
class TestAuditWriter:
    @pytest.mark.asyncio
    async def test_write_success_returns_true(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        writer = AuditWriter(session)
        ok = await writer.write(AuditEvent(action="auth.signin"))
        assert ok is True
        session.execute.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_write_failure_returns_false_and_swallows(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(side_effect=RuntimeError("DB down"))
        writer = AuditWriter(session)
        ok = await writer.write(AuditEvent(action="auth.signin"))
        # 失敗時も例外を伝播せず False を返す (defense in depth)
        assert ok is False

    @pytest.mark.asyncio
    async def test_write_serializes_metadata_as_json(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        writer = AuditWriter(session)
        event = AuditEvent(action="x", metadata={"k": "値"})
        await writer.write(event)
        _sql, params = session.execute.await_args.args
        assert '"値"' in params["metadata"]

    @pytest.mark.asyncio
    async def test_write_custom_table_name(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        writer = AuditWriter(session, table="audit_log_archive")
        await writer.write(AuditEvent(action="x"))
        sql, _params = session.execute.await_args.args
        assert "audit_log_archive" in str(sql)
