"""GAP-198: SSE の同時接続上限が「実態に合った数字」で効くことの回帰テスト。

**これまでの実態**:
    fly.toml に `soft_limit = 50` と書いてあり docs にも「同時チャット 50 人」と
    書いていたが、**SSE は張っている間ずっとリクエスト scope の DB セッションを
    1 本掴む**ので、本当の上限は DB プールの本数だった (GAP-197 以前は 1 台 15 本)。
    上限に当たると pool_timeout ぶん黙って待たされ、最後に DB のエラー文が出る
    だけで、利用者にも運営にも「混んでいる」ことが伝わらなかった。

ここで固定する事実:
  - 上限は DB プールから逆算され、普通の API 用に予備が残る
  - 上限に達したら **黙って遅くならず** 503 + 日本語で断る
  - ストリームが終わったら (切断でも) 必ず 1 本返る
  - お断りした回数が運営から見える
"""

# pyright: reportPrivateUsage=false
from __future__ import annotations

import os
from collections.abc import AsyncGenerator, AsyncIterator
from typing import cast

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
os.environ.setdefault(
    "ATELIER_DB_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)


from src.db.session import pool_capacity
from src.routes.chat_sse import guarded_stream
from src.services.chat_sse import capacity


@pytest.fixture(autouse=True)
def clean_counters():
    capacity.reset_for_tests()
    yield
    capacity.reset_for_tests()


class TestLimitDerivation:
    def test_default_comes_from_measurement_not_the_pool(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """GAP-201: 待機中は DB 接続を使わないので、プールから逆算しない。"""
        monkeypatch.delenv(capacity.MAX_CONCURRENT_ENV, raising=False)
        assert capacity.max_concurrent_streams() == capacity.DEFAULT_MAX_CONCURRENT
        # プールを小さくしても上限は変わらない (依存が切れていることの確認)
        assert pool_capacity() < capacity.DEFAULT_MAX_CONCURRENT

    def test_env_can_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "3")
        assert capacity.max_concurrent_streams() == 3

    def test_broken_env_falls_back(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "たくさん")
        assert capacity.max_concurrent_streams() == capacity.DEFAULT_MAX_CONCURRENT

    def test_never_drops_below_minimum(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """小さすぎる設定でも 0 人にはしない。"""
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "1")
        assert capacity.max_concurrent_streams() == capacity.MIN_CONCURRENT

    def test_default_is_the_measured_number(self) -> None:
        """実測に基づく値であること (GAP-202 で 150 → 1000)。

        GAP-202 で待機中のポーリングをやめたので、上限を決めていた負荷が
        消えた。実測 (.qa/gap-202): 同時 1000 人待機でメモリ +2.5MB /
        通知の配達 p95 20ms / 待機中の DB 接続 0 本。
        """
        assert capacity.DEFAULT_MAX_CONCURRENT == 1000


class TestAcquireRelease:
    def test_counts_up_and_down(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        capacity.acquire()
        assert capacity.snapshot().open_streams == 1
        capacity.release()
        assert capacity.snapshot().open_streams == 0

    def test_rejects_beyond_limit_and_counts_it(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        capacity.acquire()
        capacity.acquire()
        with pytest.raises(capacity.StreamCapacityExceeded):
            capacity.acquire()
        snap = capacity.snapshot()
        assert snap.open_streams == 2
        assert snap.rejected == 1  # 運営が実態を見られる

    def test_release_never_goes_negative(self) -> None:
        capacity.release()
        assert capacity.snapshot().open_streams == 0


class TestGuardedStream:
    @staticmethod
    async def _gen() -> AsyncIterator[bytes]:
        yield b"data: 1\n\n"
        yield b"data: 2\n\n"

    @pytest.mark.anyio
    async def test_stream_releases_after_completion(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        response = guarded_stream(self._gen())
        body = cast("AsyncGenerator[bytes, None]", response.body_iterator)
        # GAP-203: 席を取るのは **本文を流し始めたとき** (並ぶ可能性があるため)
        assert await anext(body) == b"data: 1\n\n"
        assert capacity.snapshot().open_streams == 1
        rest = [chunk async for chunk in body]
        assert rest == [b"data: 2\n\n"]
        assert capacity.snapshot().open_streams == 0

    @pytest.mark.anyio
    async def test_stream_releases_on_early_disconnect(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """途中で切られても 1 本返る (返らないと上限が減り続けて詰まる)。"""
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        response = guarded_stream(self._gen())
        iterator = cast("AsyncGenerator[bytes, None]", response.body_iterator)
        assert await anext(iterator) == b"data: 1\n\n"
        assert capacity.snapshot().open_streams == 1
        await iterator.aclose()
        assert capacity.snapshot().open_streams == 0

    @pytest.mark.anyio
    async def test_over_limit_queues_instead_of_refusing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """GAP-203: 上限を超えても **断らずに並ぶ**。

        以前 (GAP-198) はここで 503 を投げていた。だが利用者から見ると
        「混んでいる」が「壊れている」と区別できず、打った文章まで消えていた。
        """
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        first = cast("AsyncGenerator[bytes, None]", guarded_stream(self._gen()).body_iterator)
        second = cast("AsyncGenerator[bytes, None]", guarded_stream(self._gen()).body_iterator)
        await anext(first)
        await anext(second)
        assert capacity.snapshot().open_streams == 2  # 上限まで埋まった

        third = cast("AsyncGenerator[bytes, None]", guarded_stream(self._gen()).body_iterator)
        queued_event = await anext(third)
        assert b'"queued"' in queued_event, "順番待ちを伝えていない"
        assert b'"position": 1' in queued_event
        assert capacity.snapshot().queued == 1
        assert capacity.snapshot().rejected == 0, "断ってはいけない"

        # 1 本終われば、並んでいた人がそのまま本文を受け取る
        await first.aclose()
        assert await anext(third) == b"data: 1\n\n"

        await second.aclose()
        await third.aclose()
        assert capacity.snapshot().open_streams == 0

    @pytest.mark.anyio
    async def test_queue_full_returns_japanese_reason_in_the_stream(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """列まで一杯なら断る。**そのときも理由を本文で返す** (画面が読める形)。"""
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "2")
        monkeypatch.setenv(capacity.MAX_QUEUE_ENV, "0")
        open_streams = [
            cast("AsyncGenerator[bytes, None]", guarded_stream(self._gen()).body_iterator)
            for _ in range(2)
        ]
        for it in open_streams:
            await anext(it)

        refused = cast("AsyncGenerator[bytes, None]", guarded_stream(self._gen()).body_iterator)
        event = await anext(refused)
        assert b'"error"' in event
        assert "混み合っています".encode() in event
        assert "文章は消えていません".encode() in event
        assert capacity.snapshot().rejected == 1
        await refused.aclose()
        for it in open_streams:
            await it.aclose()

    def test_every_sse_endpoint_goes_through_the_guard(self) -> None:
        """SSE を返す全経路が同じ守りを通ること (1 か所だけ素通りを作らない)。"""
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1] / "src" / "routes"
        unguarded: list[str] = []
        for path in root.rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            if 'media_type="text/event-stream"' not in text:
                continue
            # 守り本体 (chat_sse) は定義元なので除外
            if path.parent.name == "chat_sse":
                continue
            unguarded.append(str(path.relative_to(root)))
        assert unguarded == [], f"guarded_stream を通っていない SSE 経路: {unguarded}"


class TestFlyConfigMatchesReality:
    @staticmethod
    def _fly() -> str:
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[3]
        return (root / "fly.toml").read_text(encoding="utf-8")

    def test_soft_limit_matches_app_limit(self) -> None:
        """fly.toml の数字が「1 台でさばける本数」と一致していること。"""
        assert f"soft_limit = {capacity.DEFAULT_MAX_CONCURRENT}" in self._fly()

    def test_old_misleading_limit_is_gone(self) -> None:
        assert "soft_limit = 50" not in self._fly()
