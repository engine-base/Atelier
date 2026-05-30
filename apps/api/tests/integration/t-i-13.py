"""T-I-13 F-J02 仕様徹底ループ統合試験 (並列 5-10).

F-J02 の徹底ループ (タスク再生 → 結果評価 → 自動 retry / 承認待ち遷移) を
複数タスク並列で走らせ、各タスクの最終 stage が期待通りに収束することを検証する。

本テストはスケルトン: 実 API connector (services.tasks.play_task 等) と
ストレス用 fixture が出揃った段階で本格化する。skeleton 状態でも構造的
不変条件 (空配列の収束) は検証する。
"""

from __future__ import annotations

import asyncio


def _terminal_stages() -> set[str]:
    """F-J02 で「完走」とみなす終端 stage の集合."""
    return {"done", "blocked", "awaiting"}


async def _play_task_sim(task_id: str) -> str:
    """play_task の simulation: 必ず done で完走する placeholder."""
    await asyncio.sleep(0)
    return "done"


def test_terminal_stages_includes_three_expected_stages() -> None:
    """F-J02 の収束 stage 集合 が done/blocked/awaiting を含むこと."""
    assert {"done", "blocked", "awaiting"} <= _terminal_stages()


def test_parallel_loop_converges() -> None:
    """並列 5 タスク全てが terminal stage に収束する (skeleton 検証)."""
    task_ids = [f"t-{i}" for i in range(5)]

    async def main() -> list[str]:
        return await asyncio.gather(*(_play_task_sim(t) for t in task_ids))

    results = asyncio.run(main())
    assert len(results) == 5
    assert all(r in _terminal_stages() for r in results)
