"""GAP-198: SSE (長時間つなぎっぱなし) の同時接続数を、実態に合わせて扱う。

**これまでの実態**:
    fly.toml には `soft_limit = 50` と書いてあり、docs にも「同時チャット 50 人で
    2 台目が起動」と書いていた。だが **SSE のストリームは張っている間ずっと
    リクエスト scope の DB セッションを 1 本掴んだまま**なので、実際の上限は
    Fly の 50 ではなく **DB プールの本数**だった (GAP-197 以前は 1 台 15 本)。
    上限に当たると `pool_timeout` ぶん黙って待たされ、最後に DB のエラー文が
    出るだけで、利用者にも運営にも「混んでいる」ことが分からなかった。

**この GAP でやること**:
    ① 上限を **アプリが自分で持つ** (DB プールから逆算する)
    ② 上限に当たったら**黙って遅くならず**、日本語で「今は混み合っている」と返す
    ③ 今いくつ開いているかを運営画面から見えるようにする

**上限の決め方**: プールの上限 − 予備。予備を残すのは、チャットで全部使い切って
**普通の画面操作 (一覧・保存) まで詰まらせない**ため。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

#: 普通の API 呼び出し用に残しておく接続数 (チャットで使い切らない)。
RESERVED_FOR_NON_STREAM = 8

#: 上限を直接指定する env (未設定なら DB プールから逆算)。
MAX_CONCURRENT_ENV = "ATELIER_SSE_MAX_CONCURRENT"

#: 逆算しても最低これだけは受ける (小さすぎる設定で 1 人も入れないのを防ぐ)。
MIN_CONCURRENT = 2


def max_concurrent_streams() -> int:
    """この 1 台が同時に張れる SSE の本数。

    既定は「DB プールの上限 − 予備」。env で明示指定もできる。
    """
    raw = (os.environ.get(MAX_CONCURRENT_ENV) or "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    from src.db.session import pool_capacity

    return max(MIN_CONCURRENT, pool_capacity() - RESERVED_FOR_NON_STREAM)


@dataclass
class _Counter:
    open_streams: int = 0
    #: これまでに「混んでいる」と断った回数 (運営が実態を見るための実測値)
    rejected: int = 0


_state = _Counter()


class StreamCapacityExceeded(Exception):
    """今は受けられない (混み合っている)。呼び出し側が 503 に変換する。"""


def acquire() -> None:
    """SSE を 1 本ぶん確保する。上限なら例外。"""
    if _state.open_streams >= max_concurrent_streams():
        _state.rejected += 1
        raise StreamCapacityExceeded
    _state.open_streams += 1


def release() -> None:
    """SSE を 1 本ぶん返す。**必ず finally で呼ぶ** (切断でも返す)。"""
    _state.open_streams = max(0, _state.open_streams - 1)


@dataclass(frozen=True)
class StreamCapacity:
    open_streams: int
    limit: int
    rejected: int

    @property
    def ratio(self) -> float:
        return self.open_streams / max(1, self.limit)


def snapshot() -> StreamCapacity:
    """今の使用状況 (運営ヘルスチェック用)。"""
    return StreamCapacity(
        open_streams=_state.open_streams,
        limit=max_concurrent_streams(),
        rejected=_state.rejected,
    )


def reset_for_tests() -> None:
    """テスト用にカウンタを初期化する。"""
    _state.open_streams = 0
    _state.rejected = 0


__all__ = [
    "MAX_CONCURRENT_ENV",
    "MIN_CONCURRENT",
    "RESERVED_FOR_NON_STREAM",
    "StreamCapacity",
    "StreamCapacityExceeded",
    "acquire",
    "max_concurrent_streams",
    "release",
    "reset_for_tests",
    "snapshot",
]
