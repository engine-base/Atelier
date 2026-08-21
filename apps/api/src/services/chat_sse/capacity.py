"""GAP-198 / GAP-201 / GAP-202: SSE (長時間つなぎっぱなし) の同時接続数。

**ここまでの経緯**:
    - GAP-198: fly.toml には `soft_limit = 50` と書いてあったが、SSE は張って
      いる間ずっと DB セッションを 1 本掴んだままだったので、実際の上限は
      **DB プールの本数** (当時 1 台 15 本) だった。
    - GAP-201: 待っている間に commit して**接続を返す**ようにした。上限は
      DB プールでは決まらなくなり、代わりに「0.25 秒ごとに 3 クエリ聞きに行く
      ポーリング負荷」が上限になった (実測で 1 台 150 本)。
    - GAP-202: その**ポーリング自体をやめた**。書き込まれた瞬間に DB から
      通知が来る (`src.db.notify`)。待っている間 DB を叩かない。

**では今は何が上限か (実測 / .qa/gap-202)**:

    | 同時待機 | メモリ増 | 通知が届くまで p95 |
    |---|---|---|
    |   150 |  0.5 MB |  12 ms |
    |  1000 |  2.5 MB |  20 ms |
    |  2000 |  3.4 MB |  27 ms |
    |  5000 | 11.0 MB |  77 ms |
    | 10000 | 17.2 MB | 505 ms  ← ここで配達が目に見えて遅れ始める |

    待機中に残る DB 負荷は「保険の再確認」だけ (通知の取りこぼし対策)。
    30 秒ごとなので 1000 人で 86 クエリ/秒、2000 人で 171 クエリ/秒
    (GAP-201 で飽和を確認した ~2,100 クエリ/秒 に対して十分小さい)。

    **既定は 1 台 1000 本** (2 台で 2000)。5000 でもまだ余裕はあるが、
    **uvicorn / Fly のプロキシが同時 1000 本の HTTP を保持したときの挙動は
    未実測**なので、そこに余白を残した数字にしている。
    上限に当たっても黙って遅くせず、日本語で状況を返す。
"""

from __future__ import annotations

import os
from dataclasses import dataclass

#: 1 台が同時に張れる SSE の本数 (実測に基づく既定 — 上の表を参照)。
#: GAP-202 でポーリングをやめたので 150 → 1000。未実測の HTTP 層に余白を残す。
DEFAULT_MAX_CONCURRENT = 1000

#: 上限を直接指定する env (未設定なら DEFAULT_MAX_CONCURRENT)。
MAX_CONCURRENT_ENV = "ATELIER_SSE_MAX_CONCURRENT"

#: 小さすぎる設定で 1 人も入れないのを防ぐ下限。
MIN_CONCURRENT = 2


def max_concurrent_streams() -> int:
    """この 1 台が同時に張れる SSE の本数。

    GAP-201 以降、**DB プールからは逆算しない** (待機中は接続を使わないため)。
    GAP-202 でポーリングもやめたので、待機はほぼ無料になった。既定は
    「通知の配達が遅れ始める手前」から余白を取った実測値。env で明示指定も可。
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
