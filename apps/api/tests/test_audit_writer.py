"""Unit tests for apps/api/src/audit/writer.py (T-D-11 schema 準拠)."""

from __future__ import annotations

import dataclasses
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter


@pytest.mark.unit
class TestAuditEvent:
    def test_minimum_construction(self) -> None:
        event = AuditEvent(action="auth.signin", target_type="user")
        assert event.action == "auth.signin"
        assert event.target_type == "user"
        # defaults
        assert event.actor_type == "system"
        assert event.actor_id == "system"
        assert event.workspace_id is None
        assert event.target_id is None
        assert event.before is None
        assert event.after is None
        assert event.ip_address is None

    def test_frozen(self) -> None:
        event = AuditEvent(action="x.y", target_type="t")
        with pytest.raises(dataclasses.FrozenInstanceError):
            event.action = "z.w"  # type: ignore[misc]

    def test_full_event(self) -> None:
        event = AuditEvent(
            action="project.update",
            target_type="project",
            actor_type="user",
            actor_id="usr_123",
            workspace_id="ws_999",
            target_id="prj_456",
            before={"name": "old"},
            after={"name": "new"},
            ip_address="1.2.3.4",
        )
        assert event.target_id == "prj_456"
        assert event.before == {"name": "old"}
        assert event.after == {"name": "new"}
        assert event.actor_type == "user"


@pytest.mark.unit
class TestAuditWriter:
    @pytest.mark.asyncio
    async def test_write_success_returns_true(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        writer = AuditWriter(session)
        ok = await writer.write(AuditEvent(action="auth.signin", target_type="user"))
        assert ok is True
        session.execute.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_write_failure_returns_false_and_swallows(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(side_effect=RuntimeError("DB down"))
        writer = AuditWriter(session)
        ok = await writer.write(AuditEvent(action="auth.signin", target_type="user"))
        # 失敗時も例外を伝播せず False を返す (defense in depth)
        assert ok is False

    @pytest.mark.asyncio
    async def test_write_serializes_before_after_as_json(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        writer = AuditWriter(session)
        event = AuditEvent(
            action="project.update",
            target_type="project",
            before={"k": "古値"},
            after={"k": "新値"},
        )
        await writer.write(event)
        _sql, params = session.execute.await_args.args
        assert '"古値"' in params["before"]
        assert '"新値"' in params["after"]

    @pytest.mark.asyncio
    async def test_write_none_before_after_passes_none(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        writer = AuditWriter(session)
        await writer.write(AuditEvent(action="auth.signin", target_type="user"))
        _sql, params = session.execute.await_args.args
        assert params["before"] is None
        assert params["after"] is None

    @pytest.mark.asyncio
    async def test_write_custom_table_name(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        writer = AuditWriter(session, table="audit_logs_archive")
        await writer.write(AuditEvent(action="x.y", target_type="t"))
        sql, _params = session.execute.await_args.args
        assert "audit_logs_archive" in str(sql)

    @pytest.mark.asyncio
    async def test_write_uses_audit_logs_by_default(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        writer = AuditWriter(session)
        await writer.write(AuditEvent(action="x.y", target_type="t"))
        sql, _params = session.execute.await_args.args
        # 新 schema は複数形
        assert "audit_logs" in str(sql)
