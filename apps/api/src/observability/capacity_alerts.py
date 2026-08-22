"""GAP-206: 混雑（順番待ち・お断り）が起きたら知らせる。

**これまでの実態**:
    GAP-203 で「断らずに並ばせる」ようにしたが、**並んだこと自体は運営画面を
    見に行かないと分からなかった**。しかも順番待ちの数字は**プロセス内の
    カウンタ**なので machine ごとに別々で、cron は 1 台でしか動かないため
    「もう 1 台で起きた混雑」には構造的に気づけなかった。

**この GAP でやること**:
    - 混雑が**起きた瞬間に DB へ 1 行**残す (`capacity_events`)。
      混雑は上限に達したときだけなので、書き込み負荷は問題にならない。
    - 既存の `error-alerts` cron に相乗りして通知する
      (**machine の起床回数を増やさない** = 追加費用 0 円)。
    - 送信に失敗したら `last_notified_at` を進めない (次回再試行)。

**どこで動くか / 誰の費用か**: 運営サーバー (Fly.io) の cron。追加費用 0 円。
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.observability.notify import (
    AlertLevel,
    AlertSettings,
    alert_settings,
    configured_channels,
    send_alert,
)
from src.services.chat_sse.capacity import StreamCapacity

logger = logging.getLogger(__name__)

#: 同じ種類を何分あけて再通知するか (鳴りっぱなしにしない)。
COOLDOWN_MINUTES = 60

#: 1 通に載せる例の件数。
SAMPLE_LIMIT = 5

KIND_LABEL = {
    "queued": "順番待ちが発生しました",
    "rejected": "混雑でお断りしました",
}


def machine_id() -> str:
    """どの machine で起きたか (Fly が入れる ID。無ければ 'local')。"""
    return (os.environ.get("FLY_MACHINE_ID") or "").strip() or "local"


async def record_capacity_event(
    session_factory: async_sessionmaker[AsyncSession],
    kind: str,
    snapshot: StreamCapacity,
    detail: str | None,
) -> None:
    """混雑イベントを 1 行残す (`capacity.set_event_recorder` から呼ばれる)。

    **失敗してもチャットは止めない** — 呼び出し側が握りつぶす契約。
    """
    async with session_factory() as session:
        await session.execute(
            text(
                "insert into public.capacity_events "
                "(kind, machine_id, open_streams, stream_limit, queued, queue_limit, detail) "
                "values (:k, :m, :o, :sl, :q, :ql, :d)"
            ),
            {
                "k": kind,
                "m": machine_id(),
                "o": snapshot.open_streams,
                "sl": snapshot.limit,
                "q": snapshot.queued,
                "ql": snapshot.queue_limit,
                "d": detail,
            },
        )
        await session.commit()


@dataclass(frozen=True)
class CapacityCandidate:
    """通知すべき混雑 (種類ごとに 1 件)。"""

    kind: str
    events: int
    machines: int
    first_at: datetime
    last_at: datetime
    peak_queued: int
    stream_limit: int
    samples: list[str]


async def find_capacity_candidates(session: AsyncSession) -> list[CapacityCandidate]:
    """前回の通知より後に起きた混雑を、種類ごとにまとめる。

    冷却時間内のものは対象にしない (同じ話で何通も送らない)。
    """
    res = await session.execute(
        text(
            "with state as ("
            "  select k.kind, s.last_notified_at"
            "    from (values ('queued'), ('rejected')) as k(kind)"
            "    left join public.capacity_alert_state s on s.kind = k.kind"
            ")"
            " select e.kind,"
            "        count(*) as events,"
            "        count(distinct e.machine_id) as machines,"
            "        min(e.occurred_at) as first_at,"
            "        max(e.occurred_at) as last_at,"
            "        max(e.queued) as peak_queued,"
            "        max(e.stream_limit) as stream_limit"
            "   from public.capacity_events e"
            "   join state on state.kind = e.kind"
            "  where e.occurred_at > coalesce(state.last_notified_at, 'epoch'::timestamptz)"
            "    and (state.last_notified_at is null"
            "         or state.last_notified_at < now() - make_interval(mins => :cooldown))"
            "  group by e.kind"
            "  order by e.kind"
        ),
        {"cooldown": COOLDOWN_MINUTES},
    )
    rows = res.all()
    candidates: list[CapacityCandidate] = []
    for row in rows:
        samples = await session.execute(
            text(
                "select to_char(occurred_at at time zone 'Asia/Tokyo', 'MM/DD HH24:MI') as at,"
                "       machine_id, open_streams, stream_limit, queued, detail"
                "  from public.capacity_events"
                " where kind = :k and occurred_at > coalesce("
                "   (select last_notified_at from public.capacity_alert_state where kind = :k),"
                "   'epoch'::timestamptz)"
                " order by occurred_at desc limit :n"
            ),
            {"k": row.kind, "n": SAMPLE_LIMIT},
        )
        lines = [
            f"{s.at} machine {s.machine_id} — 実行中 {s.open_streams}/{s.stream_limit}"
            f" · 順番待ち {s.queued}" + (f" ({s.detail})" if s.detail else "")
            for s in samples.all()
        ]
        candidates.append(
            CapacityCandidate(
                kind=str(row.kind),
                events=int(row.events),
                machines=int(row.machines),
                first_at=row.first_at,
                last_at=row.last_at,
                peak_queued=int(row.peak_queued),
                stream_limit=int(row.stream_limit),
                samples=lines,
            )
        )
    return candidates


def build_capacity_message(candidate: CapacityCandidate) -> tuple[str, list[str]]:
    """通知の本文。**何が起きて、次に何をすればいいか**まで書く。"""
    label = KIND_LABEL.get(candidate.kind, candidate.kind)
    title = f"[Atelier] {label}（{candidate.events} 回 / machine {candidate.machines} 台）"
    lines = [
        f"種類: {label}",
        f"回数: {candidate.events} 回（{candidate.machines} 台で発生）",
        f"最大の順番待ち: {candidate.peak_queued} 人（1 台あたりの上限 {candidate.stream_limit}）",
        "",
        "直近の記録:",
        *candidate.samples,
        "",
    ]
    if candidate.kind == "rejected":
        lines += [
            "**利用者は実行できませんでした。** 打った文章は消えていませんが、",
            "この状態が続くなら machine を増やす判断が要ります。",
        ]
    else:
        lines += [
            "利用者は待たされましたが、**断ってはいません**（空き次第 自動で実行）。",
            "日常的に出るようなら machine を増やす頃合いです。",
        ]
    lines += ["", "手順: docs/scaling-runbook.md"]
    return title, lines


async def purge_old_capacity_events(session: AsyncSession, *, days: int = 90) -> int:
    """保持期間を過ぎた混雑の記録を消す (**無限に太らせない**)。

    エラーログ (GAP-182) と同じ掃除ジョブに相乗りする — 専用 cron を足すと
    machine の起床回数＝課金が増えるため。
    """
    res = await session.execute(
        text(
            "delete from public.capacity_events"
            " where occurred_at < now() - make_interval(days => :d) returning id"
        ),
        {"d": max(1, days)},
    )
    return len(res.all())


async def _record_state(
    session: AsyncSession, *, kind: str, status: str, detail: str | None, advance: bool
) -> None:
    """送信結果を残す。**失敗したら last_notified_at を進めない**（次回再試行）。"""
    await session.execute(
        text(
            "insert into public.capacity_alert_state"
            " (kind, last_notified_at, notified_count, last_status, last_detail)"
            " values (:k, case when :adv then now() else null end, case when :adv then 1 else 0 end,"
            "         :st, :d)"
            " on conflict (kind) do update set"
            "   last_notified_at = case when :adv then now()"
            "     else public.capacity_alert_state.last_notified_at end,"
            "   notified_count = public.capacity_alert_state.notified_count"
            "     + case when :adv then 1 else 0 end,"
            "   last_status = :st,"
            "   last_detail = :d"
        ),
        {"k": kind, "adv": advance, "st": status, "d": detail},
    )


async def run_capacity_alerts(
    session: AsyncSession, *, settings: AlertSettings | None = None
) -> dict[str, str]:
    """cron 本体。混雑が起きていたら知らせる。"""
    cfg = settings or alert_settings()
    candidates = await find_capacity_candidates(session)
    if not candidates:
        return {"status": "ok", "name": "capacity-alerts", "candidates": "0", "sent": "0"}

    channels = configured_channels(cfg)
    sent = failed = skipped = 0
    for candidate in candidates:
        if not channels:
            await _record_state(
                session,
                kind=candidate.kind,
                status="skipped",
                detail="送信先が未設定 (ATELIER_ALERT_EMAIL_TO / ATELIER_ALERT_SLACK_WEBHOOK_URL)",
                advance=False,
            )
            skipped += 1
            continue
        title, lines = build_capacity_message(candidate)
        level: AlertLevel = "error" if candidate.kind == "rejected" else "warning"
        delivery = await send_alert(title=title, lines=lines, level=level, settings=cfg)
        await _record_state(
            session,
            kind=candidate.kind,
            status=delivery.status,
            detail=delivery.detail,
            advance=delivery.status == "sent",
        )
        if delivery.status == "sent":
            sent += 1
        else:
            failed += 1
    await session.commit()

    if failed:
        logger.warning("capacity-alerts: %d 件の通知に失敗 (次回再試行)", failed)
    return {
        "status": "ok",
        "name": "capacity-alerts",
        "candidates": str(len(candidates)),
        "sent": str(sent),
        "failed": str(failed),
        "skipped": str(skipped),
    }


__all__ = [
    "COOLDOWN_MINUTES",
    "CapacityCandidate",
    "build_capacity_message",
    "find_capacity_candidates",
    "machine_id",
    "purge_old_capacity_events",
    "record_capacity_event",
    "run_capacity_alerts",
]
