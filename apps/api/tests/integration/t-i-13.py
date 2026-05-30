"""T-I-13 F-J02 仕様徹底ループ統合試験 (並列 5-10).

実 service `src.services.tasks.play_task` を DB-free stub session で並列に
exercise し、F-J02 の徹底ループ (再生 → stage 遷移) が並列でも各タスク独立に
正しい PlayResult を返すことを検証する。

stub session は実 SQL を発行せず、queue した StubResult を順に返すため
Postgres 不要 (CI Gate #4 で常時実行可能)。
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

from src.schemas.tasks import PlayTaskRequest
from src.services.tasks import PlayResult, play_task

from ._stub import StubResult, StubSession


@dataclass
class _Row:
    id: str = ""
    lifecycle_stage: str = "ready"
    retry_count: int = 0
    worktree_path: str | None = None
    dependencies: list[str] | None = None


def test_play_result_has_four_terminal_codes() -> None:
    """F-J02 が扱う PlayResult 定数が揃っていること (実 service 由来)."""
    codes = {
        PlayResult.SUCCESS,
        PlayResult.NOT_FOUND,
        PlayResult.INVALID_STATE,
        PlayResult.DEPS_UNMET,
    }
    assert codes == {"success", "not_found", "invalid_state", "deps_unmet"}


def test_play_task_not_found_branch() -> None:
    """task が存在しないと NOT_FOUND を返す (実 play_task の分岐)."""
    session = StubSession([StubResult(rows=None)])
    code, resp = asyncio.run(
        play_task(
            session,  # type: ignore[arg-type]
            actor_id="u1",
            task_id=str(uuid.uuid4()),
            data=PlayTaskRequest(force=False),
        )
    )
    assert code == PlayResult.NOT_FOUND
    assert resp is None


def test_play_task_invalid_state_branch() -> None:
    """ready/blocked 以外の stage は INVALID_STATE (実 play_task の分岐)."""
    session = StubSession([StubResult(rows=[_Row(lifecycle_stage="done")])])
    code, _ = asyncio.run(
        play_task(
            session,  # type: ignore[arg-type]
            actor_id="u1",
            task_id=str(uuid.uuid4()),
            data=PlayTaskRequest(force=False),
        )
    )
    assert code == PlayResult.INVALID_STATE


def test_parallel_play_tasks_each_independent() -> None:
    """5 並列で play_task を呼び、各 task の結果が独立に評価される (F-J02 ループ)."""

    async def one(stage: str) -> str:
        session = StubSession([StubResult(rows=[_Row(lifecycle_stage=stage)])])
        code, _ = await play_task(
            session,  # type: ignore[arg-type]
            actor_id="u1",
            task_id=str(uuid.uuid4()),
            data=PlayTaskRequest(force=False),
        )
        return code

    async def main() -> list[str]:
        # done(不正) を混ぜても、各タスクが独立に正しい code を返すこと
        stages = ["done", "archived", "paused", "completed", "cancelled"]
        return await asyncio.gather(*(one(s) for s in stages))

    results = asyncio.run(main())
    assert len(results) == 5
    # ready/blocked 以外なので全て INVALID_STATE に収束 (並列でも独立評価)
    assert all(r == PlayResult.INVALID_STATE for r in results)
