"""DB-free unit tests for T-A-24 play_task helpers.

CI Gate #4 環境では Postgres が起動していない可能性があり、integration
tests が skip されると services/tasks 内の play_task / _all_deps_done /
_running_execution_count のカバレッジが触れた行に対して落ちる。

本ファイルは AsyncSession を SimpleNamespace で stub して実 DB 接続なしに
T-A-24 で追加した分岐を直接 exercise する。
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any

import pytest

from src.schemas.tasks import PlayTaskRequest
from src.services.tasks import (
    PlayResult,
    _all_deps_done,
    _running_execution_count,
    play_task,
)


@dataclass
class _StubResult:
    value: Any = None
    rows: list[Any] | None = None

    def scalar_one(self) -> Any:
        return self.value

    def first(self) -> Any:
        if self.rows:
            return self.rows[0]
        return None


class _StubSession:
    """最小限 AsyncSession 互換 stub。

    execute() は事前に queue した結果を順に返す。test ごとに responses を
    調整して各分岐を exercise する。
    """

    def __init__(self, responses: list[_StubResult] | None = None) -> None:
        self._responses = list(responses or [])
        self.executed_queries: list[tuple[str, dict[str, Any]]] = []

    async def execute(self, statement: Any, params: dict[str, Any] | None = None) -> _StubResult:
        sql = str(statement)
        self.executed_queries.append((sql, params or {}))
        if not self._responses:
            return _StubResult()
        return self._responses.pop(0)


def _run(coro: Awaitable[Any]) -> Any:
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture()
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


class TestPlayTaskUnit:
    def test_play_result_constants(self) -> None:
        # gate #4 が定数アクセス行 (332-348) を確実にカバーする
        assert PlayResult.SUCCESS == "success"
        assert PlayResult.NOT_FOUND == "not_found"
        assert PlayResult.INVALID_STATE == "invalid_state"
        assert PlayResult.DEPS_UNMET == "deps_unmet"

    def test_running_execution_count_returns_int(self, event_loop) -> None:
        # _running_execution_count: scalar_one() の int キャスト経路
        session = _StubSession([_StubResult(value=3)])
        asyncio.set_event_loop(event_loop)
        result = event_loop.run_until_complete(_running_execution_count(session))  # type: ignore[arg-type]
        assert result == 3
        assert "task_executions" in session.executed_queries[0][0]

    def test_all_deps_done_no_deps_returns_true(self, event_loop) -> None:
        # _all_deps_done: row is None ブランチ
        session = _StubSession([_StubResult(rows=None)])
        asyncio.set_event_loop(event_loop)
        ok = event_loop.run_until_complete(_all_deps_done(session, task_id=str(uuid.uuid4())))  # type: ignore[arg-type]
        assert ok is True

    def test_all_deps_done_empty_dependencies_array(self, event_loop) -> None:
        # row.dependencies が空配列のブランチ
        @dataclass
        class _Row:
            dependencies: list[Any]

        session = _StubSession([_StubResult(rows=[_Row(dependencies=[])])])
        asyncio.set_event_loop(event_loop)
        ok = event_loop.run_until_complete(_all_deps_done(session, task_id=str(uuid.uuid4())))  # type: ignore[arg-type]
        assert ok is True

    def test_all_deps_done_with_deps_all_complete(self, event_loop) -> None:
        @dataclass
        class _Row:
            dependencies: list[str]

        dep_id = str(uuid.uuid4())
        session = _StubSession(
            [
                _StubResult(rows=[_Row(dependencies=[dep_id])]),
                _StubResult(value=1),  # done_cnt = 1 == len(deps)
            ]
        )
        asyncio.set_event_loop(event_loop)
        ok = event_loop.run_until_complete(_all_deps_done(session, task_id=str(uuid.uuid4())))  # type: ignore[arg-type]
        assert ok is True

    def test_all_deps_done_with_deps_incomplete(self, event_loop) -> None:
        @dataclass
        class _Row:
            dependencies: list[str]

        dep_id = str(uuid.uuid4())
        session = _StubSession(
            [
                _StubResult(rows=[_Row(dependencies=[dep_id])]),
                _StubResult(value=0),  # done_cnt = 0 < 1
            ]
        )
        asyncio.set_event_loop(event_loop)
        ok = event_loop.run_until_complete(_all_deps_done(session, task_id=str(uuid.uuid4())))  # type: ignore[arg-type]
        assert ok is False

    def test_play_task_not_found_when_task_missing(self, event_loop) -> None:
        session = _StubSession([_StubResult(rows=None)])
        asyncio.set_event_loop(event_loop)
        code, payload = event_loop.run_until_complete(
            play_task(  # type: ignore[arg-type]
                session,
                actor_id=str(uuid.uuid4()),
                task_id=str(uuid.uuid4()),
                data=PlayTaskRequest(force=False),
            )
        )
        assert code == PlayResult.NOT_FOUND
        assert payload is None

    def test_play_task_invalid_state_when_done(self, event_loop) -> None:
        @dataclass
        class _Row:
            lifecycle_stage: str
            retry_count: int
            worktree_path: str | None

        session = _StubSession(
            [_StubResult(rows=[_Row(lifecycle_stage="done", retry_count=0, worktree_path=None)])]
        )
        asyncio.set_event_loop(event_loop)
        code, payload = event_loop.run_until_complete(
            play_task(  # type: ignore[arg-type]
                session,
                actor_id=str(uuid.uuid4()),
                task_id=str(uuid.uuid4()),
                data=PlayTaskRequest(force=False),
            )
        )
        assert code == PlayResult.INVALID_STATE
        assert payload is None
