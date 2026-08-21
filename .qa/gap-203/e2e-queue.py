"""GAP-203 実 e2e: 混雑しても壁にしない（本物の SSE 経路で確かめる）。

やること（フェイクの capacity ではなく **本物の guarded_stream** を使う）:
  1. 上限まで埋めて、次の人が **503 にならず順番待ちになる** ことを確かめる
  2. 並んでいる間に流れてくるイベントを実際に読み、現在地が入っていることを見る
  3. 前の人が終わったら、**並んでいた人がそのまま本文を受け取る** ことを見る
  4. 待っている途中で画面を閉じたら、**席が必ず返る**（空席が減らない）
  5. 列まで一杯のときだけ断り、そのときも **日本語の理由が本文で届く**
  6. 待ち時間の目安は、**実測が無いうちは出さない**
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import AsyncGenerator, AsyncIterator
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "e2e")
os.environ.setdefault(
    "ATELIER_DB_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
os.environ["ATELIER_SSE_MAX_CONCURRENT"] = "2"

from src.routes.chat_sse import guarded_stream
from src.services.chat_sse import capacity

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(f"  {'OK  ' if ok else 'NG  '} {label}")
    if not ok:
        failures.append(label)


async def body(hold: asyncio.Event | None = None) -> AsyncIterator[bytes]:
    """実行中の SSE 本体（hold が set されるまで開いたまま）。"""
    yield b'data: {"type": "start"}\n\n'
    if hold is not None:
        await hold.wait()
    yield b'data: {"type": "end"}\n\n'


def open_stream(hold: asyncio.Event | None = None) -> AsyncGenerator[bytes, None]:
    resp = guarded_stream(body(hold))
    return resp.body_iterator  # type: ignore[return-value]


def parse(event: bytes) -> dict[str, object]:
    return json.loads(event.decode().removeprefix("data: ").strip())


async def scenario_1_queue_instead_of_refuse() -> None:
    print("[1] 上限を超えた人は **断られずに並ぶ**")
    capacity.reset_for_tests()
    holds = [asyncio.Event(), asyncio.Event()]
    first, second = open_stream(holds[0]), open_stream(holds[1])
    await anext(first)
    await anext(second)
    check(capacity.snapshot().open_streams == 2, "上限 2 本まで埋まった")

    third = open_stream()
    event = parse(await anext(third))
    check(event.get("type") == "queued", f"順番待ちが届いた（実際 {event.get('type')}）")
    meta = event.get("metadata")
    assert isinstance(meta, dict)
    check(meta.get("position") == 1, f"現在地が入っている（{meta.get('position')} 番目）")
    check(
        meta.get("eta_seconds") is None,
        "実測が無いうちは目安を出さない（数字を作らない）",
    )
    check(capacity.snapshot().rejected == 0, "**断っていない**（503 を返していない）")
    check(capacity.snapshot().queued == 1, "列に 1 人並んでいる")

    print("[2] 前の人が終わったら、並んでいた人がそのまま本文を受け取る")
    holds[0].set()
    await anext(first)  # end
    await first.aclose()
    got = await anext(third)
    check(b'"start"' in got, f"本文が流れ始めた（実際 {got!r}）")
    check(capacity.snapshot().queued == 0, "列が空になった")

    holds[1].set()
    await second.aclose()
    await third.aclose()
    check(capacity.snapshot().open_streams == 0, "全部返った")


async def scenario_3_leaving_returns_the_seat() -> None:
    print("\n[3] 待っている途中で画面を閉じても席が減らない")
    capacity.reset_for_tests()
    holds = [asyncio.Event(), asyncio.Event()]
    first, second = open_stream(holds[0]), open_stream(holds[1])
    await anext(first)
    await anext(second)

    waiting = open_stream()
    await anext(waiting)  # queued
    check(capacity.snapshot().queued == 1, "並んでいる")
    await waiting.aclose()  # 画面を閉じた
    check(capacity.snapshot().queued == 0, "列から外れた（残り続けない）")

    holds[0].set()
    holds[1].set()
    await first.aclose()
    await second.aclose()
    check(capacity.snapshot().open_streams == 0, "席は 2 本とも戻っている")


async def scenario_4_honest_refusal() -> None:
    print("\n[4] 列まで一杯のときだけ断る（そのときも日本語で理由を返す）")
    capacity.reset_for_tests()
    os.environ["ATELIER_SSE_MAX_QUEUE"] = "0"
    try:
        holds = [asyncio.Event(), asyncio.Event()]
        first, second = open_stream(holds[0]), open_stream(holds[1])
        await anext(first)
        await anext(second)

        refused = open_stream()
        event = parse(await anext(refused))
        check(event.get("type") == "error", "error として返る")
        content = str(event.get("content", ""))
        check("混み合っています" in content, f"日本語で理由が届く: {content}")
        check(
            "文章は消えていません" in content,
            "**打った文章が消えていないこと**も伝えている",
        )
        check(capacity.snapshot().rejected == 1, "断った回数が記録される（運営が見える）")
        await refused.aclose()

        holds[0].set()
        holds[1].set()
        await first.aclose()
        await second.aclose()
    finally:
        os.environ.pop("ATELIER_SSE_MAX_QUEUE", None)


async def scenario_5_estimate_from_measurement() -> None:
    print("\n[5] 実行時間を実測したら、目安が出るようになる")
    capacity.reset_for_tests()
    check(capacity.estimated_wait_seconds(1) is None, "材料が無いうちは目安を出さない")

    # 実際に 1 本走らせて終わらせる（guarded_stream が実行時間を記録する）
    hold = asyncio.Event()
    run = open_stream(hold)
    await anext(run)
    await asyncio.sleep(0.2)
    hold.set()
    await anext(run)
    await run.aclose()

    est = capacity.estimated_wait_seconds(1)
    check(est is not None, f"実測が溜まったら目安が出る（{est}）")
    check(est is not None and est > 0, "0 秒などの嘘の値にならない")


async def main() -> None:
    await scenario_1_queue_instead_of_refuse()
    await scenario_3_leaving_returns_the_seat()
    await scenario_4_honest_refusal()
    await scenario_5_estimate_from_measurement()

    print()
    if failures:
        print(f"FAIL: {len(failures)} 件\n  - " + "\n  - ".join(failures))
        sys.exit(1)
    print("PASS: 断らず並ぶ / そのまま通る / 閉じても席が返る / 断るときも日本語 を実測")


asyncio.run(main())
