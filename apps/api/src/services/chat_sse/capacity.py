"""GAP-198 / GAP-201: SSE (長時間つなぎっぱなし) の同時接続数を実態に合わせて扱う。

**GAP-198 で分かったこと**:
    fly.toml には `soft_limit = 50` と書いてあったが、**SSE は張っている間ずっと
    リクエスト scope の DB セッションを 1 本掴んだまま**だったので、実際の上限は
    Fly の 50 ではなく **DB プールの本数** (当時 1 台 15 本) だった。
    上限に当たると `pool_timeout` ぶん黙って待たされ、最後に DB のエラー文が
    出るだけで、利用者にも運営にも「混んでいる」ことが分からなかった。

**GAP-201 で外した制約**:
    待っている間に `commit` して **DB 接続をプールへ返す**ようにした
    (RLS は `after_begin` で貼り直すので効いたまま)。実測で
    **同時 100 本を待たせても DB 接続は 0 本**になった。
    → 同時チャットの上限は **もう DB プールでは決まらない**。

**では今は何が上限か (実測 / 2026-08-20)**:
    待っている間もサーバーは 0.25 秒ごとに「Bridge から続きが届いたか」を
    見に行く。その負荷が上限を決める。

    2 回走らせた実測 (数字はマシンの都合でぶれるので幅で書く):

    | 同時待機 | 1 回のポーリング p95 |
    |---|---|
    |  50 |  46〜55 ms |
    | 100 |  57〜74 ms |
    | 150 |  76〜90 ms |
    | 200 | 104〜141 ms |
    | 400 | 699〜787 ms (飽和 = 応答が遅れ始める) |

    ポーリング間隔 250 ms に対して余裕がある **150 本/台** を既定にする
    (2 台で 300 人)。それ以上は黙って遅くせず、日本語で断る。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

#: 1 台が同時に張れる SSE の本数 (実測に基づく既定 — 上の表を参照)。
#: ポーリング p95 が間隔 250ms に対して十分速い範囲で選んでいる。
DEFAULT_MAX_CONCURRENT = 150

#: 上限を直接指定する env (未設定なら DEFAULT_MAX_CONCURRENT)。
MAX_CONCURRENT_ENV = "ATELIER_SSE_MAX_CONCURRENT"

#: 小さすぎる設定で 1 人も入れないのを防ぐ下限。
MIN_CONCURRENT = 2


def max_concurrent_streams() -> int:
    """この 1 台が同時に張れる SSE の本数。

    GAP-201 以降、**DB プールからは逆算しない** (待機中は接続を使わないため)。
    上限を決めているのは「待っている間のポーリング負荷」で、その実測値から
    既定を置いている。env で明示指定もできる。
    """
    raw = (os.environ.get(MAX_CONCURRENT_ENV) or "").strip()
    if raw.isdigit() and int(raw) > 0:
        return max(MIN_CONCURRENT, int(raw))
    return DEFAULT_MAX_CONCURRENT


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
    "DEFAULT_MAX_CONCURRENT",
    "MAX_CONCURRENT_ENV",
    "MIN_CONCURRENT",
    "StreamCapacity",
    "StreamCapacityExceeded",
    "acquire",
    "max_concurrent_streams",
    "release",
    "reset_for_tests",
    "snapshot",
]
