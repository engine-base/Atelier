"""GAP-202: 「届いた？」と聞きに行くのをやめ、届いた瞬間に知らせてもらう。

**これまでの実態**:
    チャットが本人の PC (Bridge) の実行を待っている間、サーバーは 0.25 秒ごとに
    DB へ 3 クエリ (chunk / 状態 / 承認) を投げ続けていた。待っている人数ぶん
    積み上がるので、**待機人数がそのままサーバー負荷**になっていた
    (GAP-201 の実測: 150 人で p95 76〜90ms、400 人で飽和)。

    AI の計算は利用者の PC で動いていて運営サーバーを使っていないのに、
    「届いた？」と聞き続ける部分だけで上限が決まっていた。

**この GAP でやること**:
    書き込んだ側が `pg_notify` で知らせ (trigger — 経路を増やしても漏れない)、
    SSE 側は**寝て待つ**。起きるのは自分のジョブに動きがあったときだけ。

    - LISTEN のための接続は **プロセスに 1 本だけ**。ここで各チャットへ
      プロセス内で配る (待っている人数ぶん接続を増やさない)
    - 通知は取りこぼしうる (接続断・再接続の隙間) ので、**低頻度の再確認**を
      保険として残す。取りこぼしても遅れるだけで、止まらない
    - 待ち受け接続が張れない / 落ちたままのときは、**従来のポーリング間隔へ
      自動で戻す** (黙って固まらせない)

**Supavisor を入れるときの注意**: transaction pooler 経由では LISTEN/NOTIFY が
届かない。このモジュールは **専用の直結 URL** (`ATELIER_DB_LISTEN_URL`) を
指定できるようにしてあり、未指定なら通常の DB URL を使う。
"""

# asyncpg は型情報を同梱していないため、接続オブジェクト由来の型が Unknown に
# なる。ここだけ strict の Unknown 系を落とす (このモジュール以外には影響しない)。
# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
from __future__ import annotations

import asyncio
import contextlib
import os
from dataclasses import dataclass, field

import asyncpg

from src.db.session import DatabaseSettings

#: 通知チャンネル名 (migration gap-202 の trigger と一致させること)。
CHANNEL = "chat_relay"

#: LISTEN 専用の接続文字列を分けたいとき用 (Supavisor 併用時は直結を指す)。
LISTEN_URL_ENV = "ATELIER_DB_LISTEN_URL"

#: 通知が生きているときの「保険の再確認」間隔 (秒)。
#:
#: 通知が来れば即座に起きるので、これは**取りこぼし対策**であって主経路ではない。
#: 接続が落ちたら `_on_terminated` / 再接続成功時に全員を起こして読み直させる
#: ので、ここは「落ちたと報告されないまま通知だけ消えた」への保険。
#:
#: **この値がそのまま待機中の唯一の DB 負荷になる** (N 人 × 3 クエリ / この秒数)。
#: 短くすると押し出しにした意味が薄れるので、実測に基づいて長めに取る。
HEALTHY_RECHECK_SECONDS = 30.0

#: 待ち受けが張れていないときの間隔 (秒) — 従来のポーリングへ戻す。
DEGRADED_RECHECK_SECONDS = 0.25

#: 再接続の待ち時間 (秒)。上限まで倍々。
_RECONNECT_MIN_SECONDS = 0.5
_RECONNECT_MAX_SECONDS = 30.0


def listen_dsn(settings: DatabaseSettings | None = None) -> str:
    """asyncpg に渡す DSN。SQLAlchemy の `+asyncpg` 表記を落とす。"""
    override = (os.environ.get(LISTEN_URL_ENV) or "").strip()
    raw = override or (settings or DatabaseSettings()).url  # type: ignore[call-arg]
    return raw.replace("postgresql+asyncpg://", "postgresql://", 1)


@dataclass
class NotifierStats:
    """運営画面に出す用の実測値 (推測しない)。"""

    connected: bool
    #: 今この通知を待っているチャットの本数。
    waiting: int
    #: 起動してから配った通知の数。
    delivered: int
    #: 待ち受け接続が落ちた回数 (0 でないなら保険の再確認が効いている)。
    reconnects: int
    #: 直近の失敗理由 (繋がっているなら None)。
    last_error: str | None


@dataclass
class JobNotifier:
    """1 プロセスに 1 つ。専用接続 1 本で LISTEN し、待っている各チャットへ配る。

    使い方::

        notifier = await job_notifier()
        with notifier.subscribe(job_id) as wake:
            ...
            await notifier.wait(wake)   # 動きがあるか、保険の時間まで寝る
    """

    dsn: str
    _conn: asyncpg.Connection | None = None
    _waiters: dict[str, set[asyncio.Event]] = field(default_factory=dict)
    _delivered: int = 0
    _reconnects: int = 0
    _last_error: str | None = None
    _closing: bool = False
    _reconnect_task: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------ #
    # 接続まわり
    # ------------------------------------------------------------------ #
    async def start(self) -> bool:
        """待ち受けを開始する。張れなくても **例外にしない** (保険で動く)。"""
        try:
            conn: asyncpg.Connection = await asyncpg.connect(self.dsn)
            await conn.add_listener(CHANNEL, self._on_notify)
        except Exception as exc:  # 接続不可でもチャットは動かす
            self._last_error = f"{type(exc).__name__}: {exc}"
            self._conn = None
            return False
        conn.add_termination_listener(self._on_terminated)
        self._conn = conn
        self._last_error = None
        return True

    async def close(self) -> None:
        self._closing = True
        task = self._reconnect_task
        self._reconnect_task = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        conn = self._conn
        self._conn = None
        if conn is not None:
            with contextlib.suppress(Exception):
                await conn.close()
        # 待っている人を取り残さない (次の再確認で自力で読みに行ける)。
        self._wake_all()

    @property
    def connected(self) -> bool:
        conn = self._conn
        return conn is not None and not conn.is_closed()

    def _on_terminated(self, _conn: object) -> None:
        """接続が切れた。**黙って静かにならないよう**再接続を始める。"""
        self._conn = None
        self._reconnects += 1
        self._last_error = "listen connection terminated"
        # 切れている間は誰も起こされないので、いま待っている人は一度起こす
        # (保険の間隔で読みに行かせる)。
        self._wake_all()
        if not self._closing and self._reconnect_task is None:
            with contextlib.suppress(RuntimeError):  # loop が無ければ諦める
                self._reconnect_task = asyncio.get_running_loop().create_task(
                    self._reconnect_loop()
                )

    async def _reconnect_loop(self) -> None:
        delay = _RECONNECT_MIN_SECONDS
        try:
            while not self._closing and not self.connected:
                await asyncio.sleep(delay)
                if self._closing:
                    return
                if await self.start():
                    # 切れている間の書き込みを取りこぼしている可能性がある。
                    # 待っている全員を一度起こして読み直させる。
                    self._wake_all()
                    return
                delay = min(delay * 2, _RECONNECT_MAX_SECONDS)
        finally:
            self._reconnect_task = None

    # ------------------------------------------------------------------ #
    # 配達
    # ------------------------------------------------------------------ #
    def _on_notify(
        self,
        _conn: object,
        _pid: int,
        _channel: str,
        payload: str,
    ) -> None:
        """LISTEN の受け口。payload は job_id。**該当する人だけ**起こす。"""
        events = self._waiters.get(payload)
        if not events:
            return
        self._delivered += 1
        for ev in events:
            ev.set()

    def _wake_all(self) -> None:
        for events in self._waiters.values():
            for ev in events:
                ev.set()

    @contextlib.contextmanager
    def subscribe(self, job_id: str):
        """このジョブの通知を受け取る。抜けるときに必ず登録を外す。

        最初から set 済みで返す — 購読を始める前に書き込まれていた ぶんを
        取りこぼさないよう、**1 回目は待たずに読みに行く**。
        """
        ev = asyncio.Event()
        ev.set()
        self._waiters.setdefault(job_id, set()).add(ev)
        try:
            yield ev
        finally:
            bucket = self._waiters.get(job_id)
            if bucket is not None:
                bucket.discard(ev)
                if not bucket:
                    self._waiters.pop(job_id, None)

    async def wait(self, event: asyncio.Event, *, timeout: float | None = None) -> bool:
        """動きがあるまで寝る。戻り値は「通知で起きたか」。

        timeout 省略時は、待ち受けが生きていれば長め (保険)、死んでいれば
        従来のポーリング間隔まで。**どちらでも必ず起きる**ので固まらない。
        """
        limit = timeout if timeout is not None else self.recheck_interval()
        try:
            await asyncio.wait_for(event.wait(), timeout=limit)
        except TimeoutError:
            return False
        finally:
            event.clear()
        return True

    def recheck_interval(self) -> float:
        """今の状態で使うべき再確認間隔。"""
        return HEALTHY_RECHECK_SECONDS if self.connected else DEGRADED_RECHECK_SECONDS

    def stats(self) -> NotifierStats:
        return NotifierStats(
            connected=self.connected,
            waiting=sum(len(v) for v in self._waiters.values()),
            delivered=self._delivered,
            reconnects=self._reconnects,
            last_error=self._last_error,
        )


# --------------------------------------------------------------------------- #
# プロセス (event loop) ごとに 1 つ
# --------------------------------------------------------------------------- #
_notifiers: dict[int, JobNotifier] = {}
_start_locks: dict[int, asyncio.Lock] = {}


async def job_notifier() -> JobNotifier:
    """この event loop の通知配達係。無ければ作って待ち受けを始める。

    asyncpg の接続は event loop を跨げないので loop 単位で持つ
    (`src.db.session` の engine と同じ理由)。
    """
    key = id(asyncio.get_running_loop())
    existing = _notifiers.get(key)
    if existing is not None:
        return existing
    lock = _start_locks.setdefault(key, asyncio.Lock())
    async with lock:
        existing = _notifiers.get(key)
        if existing is not None:
            return existing
        notifier = JobNotifier(dsn=listen_dsn())
        await notifier.start()  # 失敗しても保険で動く
        _notifiers[key] = notifier
        return notifier


async def notifier_health() -> NotifierStats:
    """運営画面用: 押し出しが生きているかの実測値。

    見に来たときに配達係が無ければ作る (= このプロセスの実状態を返す)。
    """
    return (await job_notifier()).stats()


async def reset_job_notifier() -> None:
    """テスト用: この loop の配達係を畳んで捨てる。"""
    key = id(asyncio.get_running_loop())
    notifier = _notifiers.pop(key, None)
    _start_locks.pop(key, None)
    if notifier is not None:
        await notifier.close()


__all__ = [
    "CHANNEL",
    "DEGRADED_RECHECK_SECONDS",
    "HEALTHY_RECHECK_SECONDS",
    "LISTEN_URL_ENV",
    "JobNotifier",
    "NotifierStats",
    "job_notifier",
    "listen_dsn",
    "notifier_health",
    "reset_job_notifier",
]
