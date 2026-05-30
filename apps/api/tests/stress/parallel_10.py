"""T-I-15 並列 10 並列 ストレス試験.

10 並列で task play API を叩いた際の throughput / error rate / latency
分布を検証する。

スケルトン: 実 dispatcher integration 後に本格化。現状は並列実行が
deadlock せず完走することのみ確認。
"""

from __future__ import annotations

import asyncio


async def _simulated_play(task_id: str) -> bool:
    """play_task 1 回分の simulation. 必ず True を返す placeholder."""
    await asyncio.sleep(0.001)
    return True


def test_10_parallel_completes_without_deadlock() -> None:
    """10 並列の play_task simulation が全て完走する."""

    async def main() -> list[bool]:
        return await asyncio.gather(*(_simulated_play(f"t-{i}") for i in range(10)))

    results = asyncio.run(main())
    assert len(results) == 10
    assert all(results), "並列実行のいずれかが失敗した (deadlock もしくは error)"
