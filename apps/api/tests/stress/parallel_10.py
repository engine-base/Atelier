"""T-I-15 並列 10 並列 ストレス試験.

実 service `src.services.tasks.play_task` を 10 並列で stub session 越しに
呼び、10 並列が deadlock せず全て完了することを検証する。

注: 真の負荷試験 (実 Postgres + 実 dispatcher) は本番前の手動 load test で
実施する。本 test は service ロジックの並列安全性 (state 共有なし) を担保する
位置付け。
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

from src.schemas.tasks import PlayTaskRequest
from src.services.tasks import (
    _PARALLEL_LIMIT,  # pyright: ignore[reportPrivateUsage]
    PlayResult,
    play_task,
)
from tests.integration._stub import StubResult, StubSession


@dataclass
class _TaskRow:
    id: str = ""
    lifecycle_stage: str = "ready"
    retry_count: int = 0
    worktree_path: str | None = None


def _ready_session(running_count: int) -> StubSession:
    """play_task が SUCCESS まで進むのに必要な StubResult 列を組む.

    play_task の SQL 順:
      1. task SELECT (ready)
      2. _all_deps_done -> dependencies SELECT (deps なし = rows None で True)
      3. _running_execution_count -> count
      4. task UPDATE
      5. task_executions INSERT
      6. audit_logs INSERT (AuditWriter, best-effort)
    """
    return StubSession(
        [
            StubResult(rows=[_TaskRow(lifecycle_stage="ready")]),
            StubResult(rows=None),  # _all_deps_done: row None → True
            StubResult(value=running_count),  # _running_execution_count
            StubResult(),  # UPDATE tasks
            StubResult(),  # INSERT task_executions
            StubResult(),  # audit_logs
            StubResult(),  # 予備
            StubResult(),  # 予備
        ]
    )


def test_parallel_limit_constant() -> None:
    """_PARALLEL_LIMIT は 5 (実 service 定数)."""
    assert _PARALLEL_LIMIT == 5


def test_10_parallel_play_completes_without_deadlock() -> None:
    """10 並列で play_task を呼んでも全て完了し deadlock しない."""

    async def one(running: int) -> str:
        session = _ready_session(running)
        code, _ = await play_task(
            session,  # type: ignore[arg-type]
            actor_id="u1",
            task_id=str(uuid.uuid4()),
            data=PlayTaskRequest(force=False),
        )
        return code

    async def main() -> list[str]:
        # running_count を 0..9 と変化させ、5 超過分が queued になる状況を含む
        return await asyncio.gather(*(one(i) for i in range(10)))

    results = asyncio.run(main())
    assert len(results) == 10
    # ready + deps 完了なので全て SUCCESS (queue_position は内部で付与)
    assert all(r == PlayResult.SUCCESS for r in results), results
