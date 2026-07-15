"""T-A-53: digest.py の非 PG ユニットテスト (Gate #4 用 — 実 PG 検証は test_cron_digest.py)。

fake session で SQL 経路を order-based に駆動し、整形/冪等/skip 分岐を検証する。
"""

# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false
from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from src.services.cron.digest import (
    DIGEST_THREAD_TITLE,
    build_project_digest,
    run_daily_digest,
)


class _Result:
    def __init__(self, rows: list[Any]):
        self._rows = rows

    def first(self) -> Any | None:
        return self._rows[0] if self._rows else None

    def all(self) -> list[Any]:
        return self._rows

    def scalar_one(self) -> Any:
        return self._rows[0]


class FakeSession:
    """execute() を呼び出し順に canned result で返す fake AsyncSession。"""

    def __init__(self, results: list[list[Any]]):
        self._results = results
        self.statements: list[str] = []
        self.committed = False

    async def execute(self, stmt: Any, params: Any = None) -> _Result:
        self.statements.append(str(stmt))
        if self._results:
            return _Result(self._results.pop(0))
        return _Result([])

    async def commit(self) -> None:
        self.committed = True


def _row(**kw: Any) -> SimpleNamespace:
    return SimpleNamespace(**kw)


class TestBuildProjectDigest:
    async def test_formats_all_sections(self) -> None:
        session = FakeSession(
            [
                [_row(name="案件X", status="active")],
                [_row(lifecycle_stage="ready", n=2), _row(lifecycle_stage="done", n=1)],
                [_row(name="設計", status="in_progress")],
                [_row(status="succeeded", n=3)],
            ]
        )
        md = await build_project_digest(session, project_id="p1")  # type: ignore[arg-type]
        assert "# 日次ダイジェスト — 案件X" in md
        assert "- ready: 2 件" in md
        assert "- 設計: in_progress" in md
        assert "- succeeded: 3 件" in md

    async def test_empty_project_uses_placeholders(self) -> None:
        session = FakeSession([[], [], [], []])
        md = await build_project_digest(session, project_id="p1")  # type: ignore[arg-type]
        assert "- タスクなし" in md
        assert "- フェーズ未定義" in md
        assert "- 実行なし" in md


class TestRunDailyDigest:
    async def test_zero_schedules_returns_ok(self) -> None:
        session = FakeSession([[]])
        result = await run_daily_digest(session)  # type: ignore[arg-type]
        assert result == {"generated": 0, "skipped": 0}
        assert session.committed

    async def test_skips_when_no_ai_employee(self) -> None:
        session = FakeSession(
            [
                [_row(id="s1", project_id="p1")],  # schedules
                [],  # 既存 thread なし
                [],  # ai_employee なし → skip
            ]
        )
        result = await run_daily_digest(session)  # type: ignore[arg-type]
        assert result == {"generated": 0, "skipped": 1}

    async def test_skips_when_digest_already_today(self) -> None:
        session = FakeSession(
            [
                [_row(id="s1", project_id="p1")],  # schedules
                [_row(id="t1")],  # 既存 thread
                [_row(x=1)],  # 当日分あり → skip
            ]
        )
        result = await run_daily_digest(session)  # type: ignore[arg-type]
        assert result == {"generated": 0, "skipped": 1}

    async def test_generates_message_and_audit(self) -> None:
        session = FakeSession(
            [
                [_row(id="s1", project_id="p1")],  # schedules
                [_row(id="t1")],  # 既存 thread
                [],  # 当日分なし
                [_row(name="案件X", status="active")],  # digest: project
                [_row(lifecycle_stage="ready", n=1)],  # digest: tasks
                [],  # digest: phases
                [],  # digest: executions
                # 以降 insert message / audit insert は空 result で良い
            ]
        )
        result = await run_daily_digest(session)  # type: ignore[arg-type]
        assert result == {"generated": 1, "skipped": 0}
        joined = "\n".join(session.statements)
        assert "insert into public.chat_messages" in joined
        assert session.committed

    async def test_thread_created_when_absent(self) -> None:
        session = FakeSession(
            [
                [_row(id="s1", project_id="p1")],  # schedules
                [],  # thread なし
                [_row(id="emp1")],  # ai_employee あり → create
                [],  # insert thread
                [],  # 当日分なし
                [_row(name="案件X", status="active")],
                [],
                [],
                [],
            ]
        )
        result = await run_daily_digest(session)  # type: ignore[arg-type]
        assert result["generated"] == 1
        joined = "\n".join(session.statements)
        assert "insert into public.chat_threads" in joined
        assert DIGEST_THREAD_TITLE  # 定数が公開されている (structural)
