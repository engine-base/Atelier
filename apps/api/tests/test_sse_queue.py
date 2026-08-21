"""GAP-203: 混雑しても**断らずに並んでもらう**。

**これまでの実態**:
    同時本数の上限を 1 本でも超えると即 503。画面はサーバーが返した日本語を
    読まずに `HTTP 503` とだけ扱っていたので、利用者には
    「AI 応答の取得に失敗しました」という汎用エラーしか出ず、**打った文章まで
    消えていた**。混雑がそのまま故障に見えていた。

ここで固定する事実:
  - 上限に当たったら並ぶ (503 にしない)
  - 並んでいる間、現在地が届く
  - 席が空いたら**列の先頭から**通る (後から来た人が割り込まない)
  - 待っている途中で抜けたら列から外れ、**席は必ず返る** (空席が減らない)
  - 列まで一杯 / 待たせすぎ のときだけ断る (そのときも理由を日本語で返す)
  - 待ち時間の目安は**実測が無いうちは出さない** (数字を作らない)
"""

# autouse fixture は pytest が呼ぶので、未使用に見えるのを許可する
# pyright: reportUnusedFunction=false
from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator

import pytest

from src.services.chat_sse import capacity


@pytest.fixture(autouse=True)
def _clean() -> None:
    capacity.reset_for_tests()


def _fill(monkeypatch: pytest.MonkeyPatch, limit: int = 2) -> None:
    """上限を `limit` 本にして、その全部を埋める (次の人は必ず並ぶ状態)。

    上限は MIN_CONCURRENT=2 で下限が効くので、1 は指定できない。
    """
    monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, str(limit))
    for _ in range(limit):
        capacity.acquire()


async def _drain(
    gen: AsyncGenerator[capacity.QueuedUpdate, None],
) -> list[capacity.QueuedUpdate]:
    """`wait_for_slot()` を回して、席が取れるまでの現在地を集める。"""
    return [update async for update in gen]


class TestNoQueueWhenFree:
    @pytest.mark.anyio
    async def test_free_slot_returns_immediately(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """空いていれば **何も待たせない** (今までと同じ体験)。"""
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        seen = await _drain(capacity.wait_for_slot())
        assert seen == [], "空いているのに順番待ちを出してはいけない"
        assert capacity.snapshot().open_streams == 1
        capacity.release()
        assert capacity.snapshot().open_streams == 0


class TestQueueing:
    @pytest.mark.anyio
    async def test_over_limit_waits_instead_of_failing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """上限を超えたら **断らずに並ぶ**。空いたらそのまま通る。"""
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        capacity.acquire()
        capacity.acquire()
        assert capacity.snapshot().open_streams == 2

        updates: list[capacity.QueuedUpdate] = []

        async def waiter() -> None:
            async for u in capacity.wait_for_slot():
                updates.append(u)

        task = asyncio.create_task(waiter())
        await asyncio.sleep(0.05)
        assert capacity.snapshot().queued == 1
        assert updates and updates[0].position == 1

        capacity.release()  # 1 本終わった → 先頭が通る
        await asyncio.wait_for(task, timeout=2.0)

        assert capacity.snapshot().queued == 0
        assert capacity.snapshot().open_streams == 2  # 空いた席をそのまま使う
        assert capacity.snapshot().rejected == 0, "断ってはいけない"

    @pytest.mark.anyio
    async def test_first_in_first_out(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """先に並んだ人が先に通る (後から来た人が割り込まない)。"""
        _fill(monkeypatch)
        order: list[int] = []

        async def waiter(n: int) -> None:
            async for _ in capacity.wait_for_slot():
                pass
            order.append(n)

        first = asyncio.create_task(waiter(1))
        await asyncio.sleep(0.02)
        second = asyncio.create_task(waiter(2))
        await asyncio.sleep(0.05)
        assert capacity.snapshot().queued == 2

        capacity.release()
        await asyncio.wait_for(first, timeout=2.0)
        capacity.release()
        await asyncio.wait_for(second, timeout=2.0)
        assert order == [1, 2]
        capacity.release()

    @pytest.mark.anyio
    async def test_new_arrival_does_not_jump_the_queue(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """列に人がいる間、後から来た人は空きがあっても割り込めない。"""
        _fill(monkeypatch)

        async def waiter() -> None:
            async for _ in capacity.wait_for_slot():
                pass

        task = asyncio.create_task(waiter())
        await asyncio.sleep(0.05)
        assert capacity.snapshot().queued == 1
        # 列に人が並んでいる状態では、即取りは失敗する
        assert capacity.try_acquire() is False

        capacity.release()
        await asyncio.wait_for(task, timeout=2.0)
        capacity.release()

    @pytest.mark.anyio
    async def test_position_counts_down(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """前の人が通ると自分の番号が繰り上がる。"""
        _fill(monkeypatch)
        monkeypatch.setattr(capacity, "POSITION_REFRESH_SECONDS", 0.02)
        seen: list[int] = []

        async def front() -> None:
            async for _ in capacity.wait_for_slot():
                pass

        async def back() -> None:
            async for u in capacity.wait_for_slot():
                seen.append(u.position)

        f = asyncio.create_task(front())
        await asyncio.sleep(0.02)
        b = asyncio.create_task(back())
        await asyncio.sleep(0.05)
        assert 2 in seen, f"最初は 2 番目のはず (実際 {seen})"

        capacity.release()
        await asyncio.wait_for(f, timeout=2.0)
        await asyncio.sleep(0.08)
        assert 1 in seen, f"前が通ったら 1 番目に繰り上がるはず (実際 {seen})"

        capacity.release()
        await asyncio.wait_for(b, timeout=2.0)
        capacity.release()


class TestLeaving:
    @pytest.mark.anyio
    async def test_leaving_the_queue_frees_the_place(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """待っている途中で画面を閉じたら列から外れる (残り続けない)。"""
        _fill(monkeypatch)
        gen = capacity.wait_for_slot()
        assert (await gen.__anext__()).position == 1
        assert capacity.snapshot().queued == 1

        await gen.aclose()  # 画面を閉じた
        assert capacity.snapshot().queued == 0

    @pytest.mark.anyio
    async def test_slot_is_returned_when_leaving_right_after_grant(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """席を貰った直後に抜けても**空席が減ったままにならない**。

        ここを取りこぼすと、混むほど使える席が目減りしていく。
        """
        _fill(monkeypatch)
        gen = capacity.wait_for_slot()
        assert (await gen.__anext__()).position == 1

        capacity.release()  # 席が割り当てられる (open_streams は 2 のまま)
        assert capacity.snapshot().open_streams == 2
        await gen.aclose()  # 受け取る前に抜けた
        assert capacity.snapshot().open_streams == 1, "貰った席が返っていない"


class TestHonestRefusal:
    @pytest.mark.anyio
    async def test_refuses_when_the_queue_is_full(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """列まで一杯なら正直に断る (無限には並ばせない)。"""
        monkeypatch.setenv(capacity.MAX_QUEUE_ENV, "1")
        _fill(monkeypatch)

        async def waiter() -> None:
            async for _ in capacity.wait_for_slot():
                pass

        task = asyncio.create_task(waiter())
        await asyncio.sleep(0.05)
        assert capacity.snapshot().queued == 1

        with pytest.raises(capacity.StreamCapacityExceeded):
            await _drain(capacity.wait_for_slot())
        assert capacity.snapshot().rejected == 1

        capacity.release()
        await asyncio.wait_for(task, timeout=2.0)
        capacity.release()

    @pytest.mark.anyio
    async def test_refuses_when_waiting_too_long(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """待たせすぎるくらいなら断る (永遠に待たせない)。"""
        monkeypatch.setenv(capacity.MAX_WAIT_ENV, "0.1")
        monkeypatch.setattr(capacity, "POSITION_REFRESH_SECONDS", 0.02)
        _fill(monkeypatch)

        with pytest.raises(capacity.StreamCapacityExceeded):
            await _drain(capacity.wait_for_slot())
        assert capacity.snapshot().queued == 0, "断ったのに列に残っている"
        assert capacity.snapshot().rejected == 1
        capacity.release()


class TestEstimate:
    def test_no_estimate_before_any_measurement(self) -> None:
        """材料が無いうちは目安を**出さない** (数字を作らない)。"""
        assert capacity.estimated_wait_seconds(1) is None

    def test_estimate_uses_measured_durations(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """実測した実行時間から出す。"""
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        capacity.record_duration(10.0)
        capacity.record_duration(20.0)
        # 平均 15 秒 / 1 巡で 2 人ぶん空く
        assert capacity.estimated_wait_seconds(1) == 15.0
        assert capacity.estimated_wait_seconds(2) == 15.0
        assert capacity.estimated_wait_seconds(3) == 30.0

    def test_zero_position_has_no_estimate(self) -> None:
        capacity.record_duration(5.0)
        assert capacity.estimated_wait_seconds(0) is None


class TestSnapshot:
    @pytest.mark.anyio
    async def test_snapshot_reports_the_queue(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """運営画面が「断ってはいないが待たせている」を見分けられること。"""
        _fill(monkeypatch)

        async def waiter() -> None:
            async for _ in capacity.wait_for_slot():
                pass

        task = asyncio.create_task(waiter())
        await asyncio.sleep(0.05)
        snap = capacity.snapshot()
        assert snap.queued == 1
        assert snap.queued_total == 1
        assert snap.rejected == 0
        assert snap.queue_limit == 4  # 上限 2 × QUEUE_MULTIPLIER

        capacity.release()
        await asyncio.wait_for(task, timeout=2.0)
        assert capacity.snapshot().longest_wait_seconds > 0
        capacity.release()
