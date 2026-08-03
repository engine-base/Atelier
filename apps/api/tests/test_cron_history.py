# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnusedFunction=false
"""GAP-013 cron 実行履歴 (record_run / list_runs) の unit tests。

record_run は DB factory を monkeypatch した stub session で
running→success/error の記録順序と best-effort (履歴失敗でも cron は動く) を検証。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable
from typing import Any

import pytest

from src.services.cron import history


class _StubResult:
    def __init__(self, value: Any = None) -> None:
        self._value = value

    def scalar_one(self) -> Any:
        return self._value

    def all(self) -> list[Any]:
        return []


class _StubSession:
    def __init__(self, store: list[tuple[str, dict[str, Any]]]) -> None:
        self._store = store

    async def execute(self, statement: Any, params: dict[str, Any] | None = None) -> _StubResult:
        sql = " ".join(str(statement).split())
        self._store.append((sql, params or {}))
        if "insert into public.cron_run_history" in sql:
            return _StubResult(str(uuid.uuid4()))
        return _StubResult()

    async def commit(self) -> None:
        return None


class _Factory:
    def __init__(self, store: list[tuple[str, dict[str, Any]]]) -> None:
        self._store = store

    def __call__(self) -> _Factory:
        return self

    async def __aenter__(self) -> _StubSession:
        return _StubSession(self._store)

    async def __aexit__(self, *args: Any) -> None:
        return None


def _run(coro: Awaitable[Any]) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture()
def store(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    import src.db as db_mod

    executed: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(db_mod, "create_engine", lambda: object())
    monkeypatch.setattr(db_mod, "create_session_factory", lambda _e: _Factory(executed))  # pyright: ignore[reportUnknownLambdaType]
    return executed


class TestRecordRun:
    def test_success_records_running_then_success(
        self, store: list[tuple[str, dict[str, Any]]]
    ) -> None:
        async def body() -> dict[str, str]:
            return {"status": "ok", "processed": "3"}

        result = _run(history.record_run("transcribe-queue", body))
        assert result == {"status": "ok", "processed": "3"}
        inserts = [p for s, p in store if "insert into public.cron_run_history" in s]
        updates = [(s, p) for s, p in store if "update public.cron_run_history" in s]
        assert inserts == [{"name": "transcribe-queue"}]
        assert len(updates) == 1
        assert updates[0][1]["st"] == "success"
        assert '"processed": "3"' in str(updates[0][1]["d"])

    def test_error_records_error_and_reraises(
        self, store: list[tuple[str, dict[str, Any]]]
    ) -> None:
        async def body() -> dict[str, str]:
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            _run(history.record_run("daily-digest", body))
        updates = [(s, p) for s, p in store if "update public.cron_run_history" in s]
        assert len(updates) == 1
        assert updates[0][1]["st"] == "error"
        assert "boom" in str(updates[0][1]["d"])

    def test_history_failure_does_not_break_cron(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """履歴 DB が死んでいても cron 本体は成功する (best-effort)。"""
        import src.db as db_mod

        def _explode() -> Any:
            raise RuntimeError("db down")

        monkeypatch.setattr(db_mod, "create_engine", _explode)

        async def body() -> dict[str, str]:
            return {"status": "ok"}

        assert _run(history.record_run("weekly-burndown", body)) == {"status": "ok"}
