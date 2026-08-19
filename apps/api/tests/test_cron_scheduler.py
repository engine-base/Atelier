"""Unit tests for apps/api/src/cron/scheduler.py + inngest_handlers.py."""

# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false
from __future__ import annotations

import inngest
import pytest

from src.cron import CRON_SCHEDULES, CronSchedule, register_cron_jobs
from src.cron.inngest_handlers import _user_schedules_body, build_cron_function


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

    def test_reports_are_driven_by_user_schedules_not_fixed_crons(self) -> None:
        """GAP-179: 配信時刻は利用者の cron_schedules が決める。

        以前は daily-digest / weekly-burndown が固定時刻 (22:00 UTC 等) で
        先に配信してしまい、画面で指定した時刻が無視されていた。
        """
        names = {s.name for s in CRON_SCHEDULES}
        assert "user-schedules" in names
        assert "daily-digest" not in names
        assert "weekly-burndown" not in names

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
    async def test_user_schedules_body_runs_due_schedules(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """GAP-179: 利用者が指定した時刻で発火させる handler が居ること。"""
        import src.services.cron.dispatcher as dispatcher_mod

        async def _fake_run(_session: object) -> dict[str, int]:
            return {"due": 2, "ran": 1, "deferred": 1, "failed": 0, "scheduled": 0}

        class _FakeSession:
            async def __aenter__(self) -> object:
                return object()

            async def __aexit__(self, *exc: object) -> None:
                return None

        monkeypatch.setattr(dispatcher_mod, "run_due_schedules", _fake_run)
        import src.db as db_mod

        monkeypatch.setattr(db_mod, "create_engine", lambda: None)
        monkeypatch.setattr(db_mod, "create_session_factory", lambda _eng: _FakeSession)
        result = await _user_schedules_body(ctx=None, step=None)
        assert result == {
            "status": "ok",
            "name": "user-schedules",
            "due": "2",
            "ran": "1",
            "deferred": "1",
            "failed": "0",
        }


@pytest.mark.unit
class TestCronModuleApi:
    def test_module_exports(self) -> None:
        import src.cron as cron_mod

        for name in ("CRON_SCHEDULES", "CronSchedule", "register_cron_jobs"):
            assert hasattr(cron_mod, name)
