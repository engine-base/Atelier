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

import asyncio
import contextlib
import logging
import os
import time
from collections import deque
from collections.abc import AsyncGenerator, Awaitable, Callable
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

#: 1 台が同時に張れる SSE の本数 (実測に基づく既定 — 上の表を参照)。
#: GAP-202 でポーリングをやめたので 150 → 1000。未実測の HTTP 層に余白を残す。
DEFAULT_MAX_CONCURRENT = 1000

#: 上限を直接指定する env (未設定なら DEFAULT_MAX_CONCURRENT)。
MAX_CONCURRENT_ENV = "ATELIER_SSE_MAX_CONCURRENT"

#: 小さすぎる設定で 1 人も入れないのを防ぐ下限。
MIN_CONCURRENT = 2

# --------------------------------------------------------------------------- #
# GAP-203: 上限に当たっても**断らない**。並んでもらって、空き次第 自動で通す。
#
# これまでは上限を 1 本でも超えると即 503 で、利用者は「AI 応答の取得に失敗
# しました」と言われて**打った文章まで消えていた**。上限は「同時に実行できる
# 数」であって「受け付けられない数」ではないので、待たせて通す。
# --------------------------------------------------------------------------- #

#: 並べる人数の上限 (上限本数の何倍まで) — 無限には並ばせない。
QUEUE_MULTIPLIER = 2

#: 並べる人数を直接指定する env。
MAX_QUEUE_ENV = "ATELIER_SSE_MAX_QUEUE"

#: これ以上待たせるくらいなら正直に断る秒数。
DEFAULT_MAX_WAIT_SECONDS = 180.0
MAX_WAIT_ENV = "ATELIER_SSE_MAX_WAIT"

#: 順番待ちの現在地を画面へ流す間隔 (秒)。
POSITION_REFRESH_SECONDS = 1.0

#: 待ち時間の目安を出すために覚えておく「直近の実行時間」の件数。
_DURATION_SAMPLES = 20


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


def max_queued_streams() -> int:
    """並べる人数の上限 (これを超えたら正直に断る)。"""
    raw = (os.environ.get(MAX_QUEUE_ENV) or "").strip()
    if raw.isdigit():
        return int(raw)
    return max_concurrent_streams() * QUEUE_MULTIPLIER


def max_wait_seconds() -> float:
    """これ以上待たせるくらいなら断る秒数。"""
    raw = (os.environ.get(MAX_WAIT_ENV) or "").strip()
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_MAX_WAIT_SECONDS
    return value if value > 0 else DEFAULT_MAX_WAIT_SECONDS


# --------------------------------------------------------------------------- #
# GAP-206: 混雑が起きたことを **machine をまたいで**残せるようにする。
#
# 上のカウンタはプロセス内の値なので、machine が 2 台あると別々になる。
# 通知の cron は 1 台でしか動かないため、そのままでは「もう 1 台で起きた混雑」に
# 気づけない。そこで**混雑が起きた瞬間に記録する**口をここに開けておく。
#
# このモジュールは DB を知らない (テストが軽いままであることに意味がある) ので、
# **実際の記録先はアプリ起動時に差し込む**。差し込まれていなければ何もしない。
# --------------------------------------------------------------------------- #
EventRecorder = Callable[[str, "StreamCapacity", str | None], Awaitable[None]]

_recorder: EventRecorder | None = None


def set_event_recorder(recorder: EventRecorder | None) -> None:
    """混雑イベントの記録先を差し込む (アプリ起動時に 1 回)。"""
    global _recorder
    _recorder = recorder


#: 記録に許す時間。**DB が遅いときに利用者を待たせない**ための上限。
RECORD_TIMEOUT_SECONDS = 2.0


async def _record_event(kind: str, detail: str | None = None) -> None:
    """記録する。**記録に失敗してもチャットは止めない** (通知は主目的ではない)。

    書き込みは 1 行で、混雑したときにしか走らないのでその場で待つ。ただし
    DB が詰まったときに**利用者の順番待ち通知まで遅れる**のは本末転倒なので、
    上限時間を切る (超えたら記録を諦めて先へ進む)。
    """
    if _recorder is None:
        return
    try:
        await asyncio.wait_for(_recorder(kind, snapshot(), detail), RECORD_TIMEOUT_SECONDS)
    except Exception:  # pragma: no cover - 記録失敗でチャットを壊さない
        logger.warning("混雑イベントの記録に失敗しました (kind=%s)", kind, exc_info=True)


@dataclass
class _Ticket:
    """順番待ちの整理券。空いたら `event` が set され、席は確保済みになる。"""

    event: asyncio.Event = field(default_factory=asyncio.Event)
    #: 席を割り当てられたか (割り当て済みなら release() の責任を負う)
    granted: bool = False


@dataclass
class _Counter:
    open_streams: int = 0
    #: これまでに「混んでいる」と断った回数 (運営が実態を見るための実測値)
    rejected: int = 0
    #: 順番待ちの列 (先に来た人が先に通る)
    queue: deque[_Ticket] = field(default_factory=lambda: deque[_Ticket]())
    #: これまでに順番待ちに入った回数 / 待たせた最長秒数 (実測を残す)
    queued_total: int = 0
    longest_wait_seconds: float = 0.0
    #: 直近の実行時間 (待ち時間の目安を**推測ではなく実測から**出すため)
    recent_durations: deque[float] = field(default_factory=lambda: deque(maxlen=_DURATION_SAMPLES))


_state = _Counter()


class StreamCapacityExceeded(Exception):
    """今は受けられない (並ぶ列まで一杯 / 待たせすぎ)。呼び出し側が 503 に変換する。"""


def acquire() -> None:
    """SSE を 1 本ぶん確保する。上限なら例外 (並ばずに即断る用)。"""
    if not try_acquire():
        _state.rejected += 1
        raise StreamCapacityExceeded


def try_acquire() -> bool:
    """空いていれば席を取る。取れたら True。

    **列に人が並んでいるときは割り込まない** — 後から来た人が先に通ると、
    並んでいる人がいつまでも通らない (飢餓) 状態になる。
    """
    if _state.queue:
        return False
    if _state.open_streams >= max_concurrent_streams():
        return False
    _state.open_streams += 1
    return True


def release() -> None:
    """SSE を 1 本ぶん返す。**必ず finally で呼ぶ** (切断でも返す)。

    返した席は、そのまま**列の先頭の人へ引き渡す**。
    """
    _state.open_streams = max(0, _state.open_streams - 1)
    _promote()


def _promote() -> None:
    """空いている席の数だけ、列の先頭から順に通す。"""
    while _state.queue and _state.open_streams < max_concurrent_streams():
        ticket = _state.queue.popleft()
        _state.open_streams += 1  # 起こす前に席を確保する (二重取りを防ぐ)
        ticket.granted = True
        ticket.event.set()


def _position(ticket: _Ticket) -> int:
    """今の並び順 (1 = 次に通る)。列から外れていたら 0。"""
    try:
        return _state.queue.index(ticket) + 1
    except ValueError:
        return 0


def record_duration(seconds: float) -> None:
    """1 本ぶんの実行時間を覚える (待ち時間の目安の材料)。"""
    if seconds > 0:
        _state.recent_durations.append(seconds)


def estimated_wait_seconds(position: int) -> float | None:
    """並び順から待ち時間の目安を出す。

    **材料が無いうちは None を返す** — 数字を作らない。画面は「まもなく」等の
    表現に落とす (根拠の無い秒数を出すと、外れたときに信用を失う)。
    """
    if position <= 0 or not _state.recent_durations:
        return None
    average = sum(_state.recent_durations) / len(_state.recent_durations)
    limit = max_concurrent_streams()
    # 自分より前の position 人が捌けるまで。1 巡で limit 人ぶん空く。
    rounds = (position + limit - 1) // limit
    return average * rounds


@dataclass(frozen=True)
class QueuedUpdate:
    """順番待ちの現在地 (SSE へそのまま流す用)。"""

    position: int
    ahead: int
    eta_seconds: float | None


async def wait_for_slot() -> AsyncGenerator[QueuedUpdate, None]:
    """席が空くまで並ぶ。並んでいる間、現在地を yield する。

    - 空いていれば **何も yield せずに** すぐ返る (今までと同じ体験)
    - 列が一杯 / 待たせすぎ のときだけ `StreamCapacityExceeded`
    - **抜けるときは必ず列から外す** (画面を閉じた人が列に残らない)

    席を取れた後の解放は呼び出し側の責任 (`release()` を finally で呼ぶ)。
    """
    if try_acquire():
        return

    if len(_state.queue) >= max_queued_streams():
        _state.rejected += 1
        await _record_event("rejected", "並ぶ列も一杯")
        raise StreamCapacityExceeded

    ticket = _Ticket()
    _state.queue.append(ticket)
    _state.queued_total += 1
    # **並び始めた瞬間**に残す (待ち終わってからでは、待たせた事実が消える)
    await _record_event("queued", f"{len(_state.queue)} 人目")
    started = time.monotonic()
    deadline = started + max_wait_seconds()
    delivered = False
    try:
        while True:
            position = _position(ticket)
            if position > 0:
                yield QueuedUpdate(
                    position=position,
                    ahead=position - 1 + _state.open_streams,
                    eta_seconds=estimated_wait_seconds(position),
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _state.rejected += 1
                await _record_event("rejected", f"{max_wait_seconds():.0f} 秒待っても空かなかった")
                raise StreamCapacityExceeded
            try:
                await asyncio.wait_for(
                    ticket.event.wait(), timeout=min(POSITION_REFRESH_SECONDS, remaining)
                )
            except TimeoutError:
                continue
            waited = time.monotonic() - started
            _state.longest_wait_seconds = max(_state.longest_wait_seconds, waited)
            delivered = True
            return
    finally:
        if ticket.granted and not delivered:
            # 席は割り当てられたのに、呼び出し側へ渡す前に抜けた
            # (待っている途中で画面を閉じた等)。**貰った席を必ず返す** —
            # ここを取りこぼすと空席が減ったまま戻らない。
            release()
        elif not ticket.granted:
            # まだ列の中なので外す (閉じた人が列に残り続けないように)。
            with contextlib.suppress(ValueError):
                _state.queue.remove(ticket)


@dataclass(frozen=True)
class StreamCapacity:
    open_streams: int
    limit: int
    rejected: int
    #: 今この瞬間 順番待ちしている人数 (GAP-203)
    queued: int = 0
    #: 並べる人数の上限
    queue_limit: int = 0
    #: 起動してから順番待ちに入った延べ人数
    queued_total: int = 0
    #: 実際に待たせた最長秒数 (推測ではなく実測)
    longest_wait_seconds: float = 0.0

    @property
    def ratio(self) -> float:
        return self.open_streams / max(1, self.limit)


def snapshot() -> StreamCapacity:
    """今の使用状況 (運営ヘルスチェック用)。"""
    return StreamCapacity(
        open_streams=_state.open_streams,
        limit=max_concurrent_streams(),
        rejected=_state.rejected,
        queued=len(_state.queue),
        queue_limit=max_queued_streams(),
        queued_total=_state.queued_total,
        longest_wait_seconds=_state.longest_wait_seconds,
    )


def reset_for_tests() -> None:
    """テスト用にカウンタを初期化する。"""
    _state.open_streams = 0
    _state.rejected = 0
    _state.queue.clear()
    _state.queued_total = 0
    _state.longest_wait_seconds = 0.0
    _state.recent_durations.clear()


__all__ = [
    "DEFAULT_MAX_CONCURRENT",
    "DEFAULT_MAX_WAIT_SECONDS",
    "MAX_CONCURRENT_ENV",
    "MAX_QUEUE_ENV",
    "MAX_WAIT_ENV",
    "MIN_CONCURRENT",
    "POSITION_REFRESH_SECONDS",
    "QUEUE_MULTIPLIER",
    "RECORD_TIMEOUT_SECONDS",
    "EventRecorder",
    "QueuedUpdate",
    "StreamCapacity",
    "StreamCapacityExceeded",
    "acquire",
    "estimated_wait_seconds",
    "max_concurrent_streams",
    "max_queued_streams",
    "max_wait_seconds",
    "record_duration",
    "release",
    "reset_for_tests",
    "set_event_recorder",
    "snapshot",
    "try_acquire",
    "wait_for_slot",
]
