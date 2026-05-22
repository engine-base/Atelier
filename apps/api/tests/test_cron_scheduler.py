"""Unit tests for apps/api/src/cron/scheduler.py + inngest_handlers.py."""

# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false
from __future__ import annotations

import inngest
import pytest

from src.cron import CRON_SCHEDULES, CronSchedule, register_cron_jobs
from src.cron.inngest_handlers import (
    _daily_digest_body,
    _weekly_burndown_body,
    build_cron_function,
)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> inngest.Inngest:
    monkeypatch.setenv("INNGEST_DEV", "1")
    return inngest.Inngest(app_id="atelier-test", is_production=False)


@pytest.mark.unit
class TestCronSchedule:
    def test_frozen_dataclass(self) -> None:
        import dataclasses

        s = CronSchedule(name="x", cron="0 0 * * *", description="d")
        with pytest.raises(dataclasses.FrozenInstanceError):
            s.name = "y"  # type: ignore[misc]

    def test_default_schedules_contain_daily_and_weekly(self) -> None:
        names = {s.name for s in CRON_SCHEDULES}
        assert "daily-digest" in names
        assert "weekly-burndown" in names

    def test_all_schedules_have_valid_5_field_cron(self) -> None:
        for s in CRON_SCHEDULES:
            fields = s.cron.split()
            assert len(fields) == 5, f"{s.name} has invalid cron: {s.cron}"


@pytest.mark.unit
class TestRegisterCronJobs:
    def test_registers_all_schedules(self, client: inngest.Inngest) -> None:
        functions = register_cron_jobs(client)
        assert len(functions) == len(CRON_SCHEDULES)

    def test_returns_list_of_functions(self, client: inngest.Inngest) -> None:
        functions = register_cron_jobs(client)
        for fn in functions:
            assert hasattr(fn, "id")


@pytest.mark.unit
class TestBuildCronFunction:
    def test_unknown_name_raises(self, client: inngest.Inngest) -> None:
        unknown = CronSchedule(name="non-existent", cron="0 0 * * *", description="x")
        with pytest.raises(ValueError, match="unknown cron"):
            build_cron_function(client, unknown)

    def test_daily_digest_registers(self, client: inngest.Inngest) -> None:
        fn = build_cron_function(client, CRON_SCHEDULES[0])
        assert fn is not None


@pytest.mark.unit
class TestHandlerBodies:
    @pytest.mark.asyncio
    async def test_daily_digest_body_returns_status_ok(self) -> None:
        result = await _daily_digest_body(ctx=None, step=None)
        assert result == {"status": "ok", "name": "daily-digest"}

    @pytest.mark.asyncio
    async def test_weekly_burndown_body_returns_status_ok(self) -> None:
        result = await _weekly_burndown_body(ctx=None, step=None)
        assert result == {"status": "ok", "name": "weekly-burndown"}


@pytest.mark.unit
class TestCronModuleApi:
    def test_module_exports(self) -> None:
        import src.cron as cron_mod

        for name in ("CRON_SCHEDULES", "CronSchedule", "register_cron_jobs"):
            assert hasattr(cron_mod, name)
