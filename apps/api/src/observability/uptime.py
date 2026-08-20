"""GAP-195: 外形監視 (uptime) — サーバーが完全に落ちたことを外から観測する。

**これまでの実態**: エラーは自前の `error_log` に貯めていた (GAP-182/194) が、
**サーバー自体が落ちたら自分ではログを書けない**。落ちている間は記録も通知も
残らず、復旧後に「いつからいつまで落ちていたか」を答えられなかった。

**どこで動くか**: 運営インフラ (Fly.io / Vercel) の**外側** = GitHub Actions。
15 分ごとに `/health` と画面を叩く。結果は **API を経由せず直接 Supabase へ**
書く (API 経由にすると、落ちているときに記録できないため)。

**誰の費用か**: 運営。GitHub Actions の実行時間のみ (1 回あたり 1 分未満 ×
月 2,880 回 ≒ 無料枠内。public リポジトリなら 0 円)。監視 SaaS の契約は不要。

**通知**: 状態が変わった時 (落ちた / 復旧した) と、落ちたままのリマインド
(既定 6 時間ごと) だけ。15 分ごとに「まだ落ちています」を送らない。

単独実行:
    uv run --project apps/api python -m src.observability.uptime
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from typing import cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .notify import AlertLevel, AlertSettings, alert_settings, send_alert

logger = logging.getLogger(__name__)

#: 落ちたままのときに再通知する間隔 (分)。15 分ごとに送らないための間引き。
DOWN_REMINDER_MINUTES = 360
#: 1 回のチェックでの試行回数。1 回のタイムアウトで「落ちた」と言わない。
ATTEMPTS = 3
#: 試行ごとのタイムアウト (秒)。
TIMEOUT_SECONDS = 10.0
#: 再試行の待ち (秒)。瞬断と本当の障害を区別するために少し待つ。
RETRY_WAIT_SECONDS = 3.0


@dataclass(frozen=True)
class Target:
    """監視対象 1 件。"""

    name: str
    url: str


@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    status_code: int | None
    latency_ms: int
    error: str | None


def parse_targets(raw: str) -> list[Target]:
    """`api=https://...,web=https://...` を解釈する。

    書式が壊れている項目は**黙って捨てず**に無視した上で警告ログを出す。
    """
    out: list[Target] = []
    for chunk in raw.split(","):
        item = chunk.strip()
        if not item:
            continue
        name, sep, url = item.partition("=")
        if not sep or not url.strip() or not name.strip():
            logger.warning("uptime target の書式が不正なので無視します: %r", item)
            continue
        out.append(Target(name=name.strip(), url=url.strip()))
    return out


def targets_from_env(env: dict[str, str] | None = None) -> list[Target]:
    source = os.environ if env is None else env
    return parse_targets(source.get("ATELIER_UPTIME_TARGETS", ""))


def _probe_once(url: str, timeout: float) -> ProbeResult:
    started = time.monotonic()
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "atelier-uptime"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            code = int(response.status)
            response.read(2048)
    except urllib.error.HTTPError as exc:
        return ProbeResult(
            ok=False,
            status_code=int(exc.code),
            latency_ms=int((time.monotonic() - started) * 1000),
            error=f"HTTP {exc.code}",
        )
    except Exception as exc:
        return ProbeResult(
            ok=False,
            status_code=None,
            latency_ms=int((time.monotonic() - started) * 1000),
            error=f"{type(exc).__name__}: {exc}"[:200],
        )
    latency = int((time.monotonic() - started) * 1000)
    ok = 200 <= code < 400
    return ProbeResult(
        ok=ok, status_code=code, latency_ms=latency, error=None if ok else f"HTTP {code}"
    )


def probe(
    url: str,
    *,
    attempts: int = ATTEMPTS,
    timeout: float = TIMEOUT_SECONDS,
    wait: float = RETRY_WAIT_SECONDS,
    sleep: Callable[[float], None] | None = None,
) -> ProbeResult:
    """1 つの URL を叩く。1 回のタイムアウトで「落ちた」と決めつけない。

    sleep はテストから差し替えるための注入点 (既定は time.sleep)。
    """
    sleeper = time.sleep if sleep is None else sleep
    last = ProbeResult(ok=False, status_code=None, latency_ms=0, error="未実行")
    for attempt in range(max(1, attempts)):
        last = _probe_once(url, timeout)
        if last.ok:
            return last
        if attempt < attempts - 1:
            sleeper(wait)
    return last


@dataclass(frozen=True)
class TargetState:
    """直前の観測状態。None = まだ一度も観測していない。"""

    ok: bool | None
    since: datetime | None
    last_notified_at: datetime | None


async def previous_state(session: AsyncSession, *, target: str) -> TargetState:
    """直前の結果と「その状態がいつから続いているか」を返す。"""
    last = (
        await session.execute(
            text(
                "select ok, checked_at from public.uptime_checks "
                " where target = :t order by checked_at desc limit 1"
            ),
            {"t": target},
        )
    ).first()
    if last is None:
        return TargetState(ok=None, since=None, last_notified_at=None)

    since = (
        await session.execute(
            text(
                "select min(checked_at) from public.uptime_checks "
                " where target = :t and ok = :o "
                "   and checked_at > coalesce(("
                "        select max(checked_at) from public.uptime_checks "
                "         where target = :t and ok <> :o), '-infinity'::timestamptz)"
            ),
            {"t": target, "o": bool(last.ok)},
        )
    ).scalar()
    notified = (
        await session.execute(
            text(
                "select max(checked_at) from public.uptime_checks  where target = :t and notified"
            ),
            {"t": target},
        )
    ).scalar()
    return TargetState(ok=bool(last.ok), since=since, last_notified_at=notified)


def should_notify(
    *, previous: TargetState, current_ok: bool, now: datetime, reminder_minutes: int
) -> tuple[bool, str]:
    """通知するか、その理由を返す。**15 分ごとに「まだ落ちています」を送らない**。"""
    if previous.ok is None:
        # 初回観測。落ちていれば知らせる。動いていれば黙っている。
        return (not current_ok, "初回観測で応答なし" if not current_ok else "")
    if previous.ok and not current_ok:
        return True, "落ちた"
    if not previous.ok and current_ok:
        return True, "復旧した"
    if not current_ok:
        last = previous.last_notified_at
        if last is None:
            return True, "落ちたままだが未通知"
        elapsed_minutes = (now - last).total_seconds() / 60
        if elapsed_minutes >= reminder_minutes:
            return True, "落ちたまま (定期リマインド)"
    return False, ""


def build_message(
    *, target: Target, result: ProbeResult, reason: str, previous: TargetState
) -> tuple[str, list[str], AlertLevel]:
    """通知の件名・本文・レベルを作る。事実だけを書く。"""
    if result.ok:
        title = f"{target.name} が復旧しました"
        lines = [
            f"URL: {target.url}",
            f"応答: HTTP {result.status_code} ({result.latency_ms} ms)",
        ]
        if previous.since is not None:
            lines.append(f"停止していた開始時刻: {previous.since:%Y-%m-%d %H:%M} UTC")
        return title, lines, "recovery"

    title = f"{target.name} が応答しません"
    lines = [
        f"URL: {target.url}",
        f"症状: {result.error or '応答なし'}",
        f"{ATTEMPTS} 回試行して全部失敗しました",
        f"判定理由: {reason}",
    ]
    if previous.since is not None and previous.ok is False:
        lines.append(f"最初に失敗した時刻: {previous.since:%Y-%m-%d %H:%M} UTC")
    return title, lines, "error"


async def record(
    session: AsyncSession, *, target: Target, result: ProbeResult, notified: bool
) -> None:
    await session.execute(
        text(
            "insert into public.uptime_checks "
            "(target, ok, status_code, latency_ms, error, notified) "
            "values (:t, :ok, :sc, :ms, :err, :n)"
        ),
        {
            "t": target.name,
            "ok": result.ok,
            "sc": result.status_code,
            "ms": result.latency_ms,
            "err": result.error,
            "n": notified,
        },
    )


async def check_targets(
    session: AsyncSession,
    targets: list[Target],
    *,
    now: datetime,
    settings: AlertSettings | None = None,
    probe_fn: Callable[[str], ProbeResult] | None = None,
    reminder_minutes: int = DOWN_REMINDER_MINUTES,
) -> dict[str, str]:
    """全対象を観測し、記録し、必要なら通知する。"""
    cfg = settings or alert_settings()
    run_probe = probe if probe_fn is None else probe_fn
    up = down = notified_count = 0
    for target in targets:
        previous = await previous_state(session, target=target.name)
        result = run_probe(target.url)
        notify, reason = should_notify(
            previous=previous,
            current_ok=result.ok,
            now=now,
            reminder_minutes=reminder_minutes,
        )
        delivered = False
        if notify:
            title, lines, level = build_message(
                target=target, result=result, reason=reason, previous=previous
            )
            delivery = await send_alert(title=title, lines=lines, level=level, settings=cfg)
            delivered = delivery.status == "sent"
            if not delivered:
                logger.warning(
                    "uptime 通知を届けられなかった (%s): %s", target.name, delivery.detail
                )
        # notified には「本当に届いた」ものだけ true を入れる。
        # 届かなかったものを true にすると、次回のリマインド判定がずれて黙ってしまう。
        await record(session, target=target, result=result, notified=delivered)
        if result.ok:
            up += 1
        else:
            down += 1
        if delivered:
            notified_count += 1
    await session.commit()
    return {
        "status": "ok",
        "name": "uptime",
        "targets": str(len(targets)),
        "up": str(up),
        "down": str(down),
        "notified": str(notified_count),
    }


@dataclass(frozen=True)
class UptimeSummary:
    """運営画面 (S-T05) 用の 1 対象ぶんの要約。"""

    target: str
    ok: bool
    last_checked_at: datetime
    #: 現在の状態が続いている開始時刻
    since: datetime | None
    #: 直近 24 時間の成功率 (%)。観測が無ければ None
    availability_24h: float | None
    #: 直近 24 時間の観測回数
    checks_24h: int
    last_error: str | None
    last_latency_ms: int | None


async def summarize(session: AsyncSession) -> list[UptimeSummary]:
    """対象ごとの現在状態と直近 24 時間の成功率を返す。"""
    names = [
        str(cast("object", r.target))
        for r in (
            await session.execute(
                text("select distinct target from public.uptime_checks order by target")
            )
        ).all()
    ]
    out: list[UptimeSummary] = []
    for name in names:
        last = (
            await session.execute(
                text(
                    "select ok, checked_at, error, latency_ms from public.uptime_checks "
                    " where target = :t order by checked_at desc limit 1"
                ),
                {"t": name},
            )
        ).first()
        if last is None:  # pragma: no cover - 直前に消えた場合のみ
            continue
        state = await previous_state(session, target=name)
        agg = (
            await session.execute(
                text(
                    "select count(*) as total, count(*) filter (where ok) as good "
                    "  from public.uptime_checks "
                    " where target = :t and checked_at > now() - interval '24 hours'"
                ),
                {"t": name},
            )
        ).one()
        total = int(agg.total)
        out.append(
            UptimeSummary(
                target=name,
                ok=bool(last.ok),
                last_checked_at=last.checked_at,
                since=state.since,
                availability_24h=(None if total == 0 else round(int(agg.good) * 100.0 / total, 2)),
                checks_24h=total,
                last_error=None if last.error is None else str(last.error),
                last_latency_ms=None if last.latency_ms is None else int(last.latency_ms),
            )
        )
    return out


async def _main() -> int:
    """GitHub Actions から呼ばれる CLI 本体。"""
    from datetime import UTC

    from src.db import shared_session_factory

    targets = targets_from_env()
    if not targets:
        print("ATELIER_UPTIME_TARGETS が未設定です (例: api=https://.../health)")
        return 2
    factory = shared_session_factory()
    async with factory() as session:
        result = await check_targets(session, targets, now=datetime.now(UTC))
    print(result)
    # 落ちている対象があれば非 0 で終わる → GitHub の実行一覧でも赤くなる
    return 1 if result["down"] != "0" else 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    return asyncio.run(_main())


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "ATTEMPTS",
    "DOWN_REMINDER_MINUTES",
    "ProbeResult",
    "Target",
    "TargetState",
    "UptimeSummary",
    "build_message",
    "check_targets",
    "parse_targets",
    "previous_state",
    "probe",
    "record",
    "should_notify",
    "summarize",
    "targets_from_env",
]
