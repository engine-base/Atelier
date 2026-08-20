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

from fastapi import HTTPException

from src.db.session import DatabaseSettings, pool_capacity
from src.routes.chat_sse import guarded_stream
from src.services.chat_sse import capacity


@pytest.fixture(autouse=True)
def clean_counters():
    capacity.reset_for_tests()
    yield
    capacity.reset_for_tests()


class TestLimitDerivation:
    def test_limit_comes_from_pool_minus_reserve(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(capacity.MAX_CONCURRENT_ENV, raising=False)
        expected = pool_capacity() - capacity.RESERVED_FOR_NON_STREAM
        assert capacity.max_concurrent_streams() == expected

    def test_reserve_keeps_room_for_normal_requests(self) -> None:
        """チャットで全部使い切って一覧・保存まで詰まらせない。"""
        assert capacity.RESERVED_FOR_NON_STREAM > 0
        assert capacity.max_concurrent_streams() < pool_capacity()

    def test_env_can_override(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "3")
        assert capacity.max_concurrent_streams() == 3

    def test_broken_env_falls_back(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "たくさん")
        assert capacity.max_concurrent_streams() == (
            pool_capacity() - capacity.RESERVED_FOR_NON_STREAM
        )

    def test_never_drops_below_minimum(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """プールが極端に小さくても 0 人にはしない。"""
        monkeypatch.delenv(capacity.MAX_CONCURRENT_ENV, raising=False)

        def _tiny(settings: DatabaseSettings | None = None) -> int:
            del settings
            return 1

        monkeypatch.setattr("src.db.session.pool_capacity", _tiny)
        assert capacity.max_concurrent_streams() >= capacity.MIN_CONCURRENT

    def test_default_pool_gives_a_usable_number(self) -> None:
        """既定設定で 22 本 (プール 30 − 予備 8)。fly.toml の soft_limit と揃える値。"""
        cfg = DatabaseSettings(
            url="postgresql+asyncpg://u:p@h:5432/db", pool_size=20, max_overflow=10
        )
        assert pool_capacity(cfg) - capacity.RESERVED_FOR_NON_STREAM == 22


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
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "1")
        response = guarded_stream(self._gen())
        assert capacity.snapshot().open_streams == 1
        body = cast("AsyncIterator[bytes]", response.body_iterator)
        chunks = [chunk async for chunk in body]
        assert chunks == [b"data: 1\n\n", b"data: 2\n\n"]
        assert capacity.snapshot().open_streams == 0

    @pytest.mark.anyio
    async def test_stream_releases_on_early_disconnect(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """途中で切られても 1 本返る (返らないと上限が減り続けて詰まる)。"""
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "1")
        response = guarded_stream(self._gen())
        iterator = cast("AsyncGenerator[bytes, None]", response.body_iterator)
        assert await anext(iterator) == b"data: 1\n\n"
        await iterator.aclose()
        assert capacity.snapshot().open_streams == 0

    @pytest.mark.anyio
    async def test_over_limit_returns_503_in_japanese(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """黙って遅くならず、その場で「混んでいる」と伝える。"""
        monkeypatch.setenv(capacity.MAX_CONCURRENT_ENV, "1")
        guarded_stream(self._gen())  # 1 本目で埋める
        with pytest.raises(HTTPException) as excinfo:
            guarded_stream(self._gen())
        assert excinfo.value.status_code == 503
        assert "混み合っています" in str(excinfo.value.detail)
        assert "1" in str(excinfo.value.detail)  # 上限の本数を伝える

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
        cfg = DatabaseSettings(
            url="postgresql+asyncpg://u:p@h:5432/db", pool_size=20, max_overflow=10
        )
        expected = pool_capacity(cfg) - capacity.RESERVED_FOR_NON_STREAM
        assert f"soft_limit = {expected}" in self._fly()

    def test_old_misleading_limit_is_gone(self) -> None:
        assert "soft_limit = 50" not in self._fly()
