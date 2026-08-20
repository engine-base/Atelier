"""GAP-194: エラーが起きたら運営に通知する (GAP-182 の記録の続き)。

**これまでの実態**: `public.error_log` に貯まるだけで誰にも届かなかった。
運営が S-T05 を開きに行かない限り、本番が壊れていても気づけない。

**どこで動くか**: 運営サーバー (Fly.io) の cron `error-alerts`。
**誰の費用か**: 運営。Resend 無料枠 / Slack Webhook のためチャネル費用は 0 円。
cron は既存の `user-schedules` と同じ 15 分間隔なので **machine の起動回数は
増えない** (= Fly.io の課金も増えない)。通知は最大 15 分遅れる — これは
「常時起動して即時通知する (月額が上がる)」より安いほうを選んだ結果で、
遅延があることを docs にも画面にも明記する。

**送らないもの**:
  - warning レベル (既定 OFF。ノイズになるため ATELIER_ALERT_NOTIFY_WARNINGS で ON)
  - 通知処理そのものの失敗 (`AlertDeliveryFailed`) — 通知ループを作らない
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .notify import AlertSettings, alert_settings, configured_channels, send_alert

logger = logging.getLogger(__name__)

#: 通知処理そのものの失敗に使う kind。**通知対象から除外する** (無限ループ防止)。
DELIVERY_FAILED_KIND = "AlertDeliveryFailed"

_SOURCE_LABEL = {"api": "サーバー", "web": "画面", "worker": "バッチ"}


@dataclass(frozen=True)
class AlertCandidate:
    """通知すべき 1 つの不具合 (fingerprint 単位にまとめたもの)。"""

    fingerprint: str
    kind: str
    message: str
    source: str
    level: str
    path: str | None
    #: 前回通知以降に新たに増えた件数 (初回は全件)
    new_count: int
    first_seen_at: datetime
    last_seen_at: datetime
    #: 過去に通知した回数 (0 = 初めて見る不具合)
    notified_count: int


def _service_factory() -> Any:
    from src.services.project_credentials import (
        _service_session_factory,  # pyright: ignore[reportPrivateUsage]
    )

    return _service_session_factory()


async def find_candidates(
    session: AsyncSession, *, settings: AlertSettings | None = None
) -> list[AlertCandidate]:
    """通知すべき不具合を新しい順で返す。

    条件は 2 つだけ:
      ① 前回通知した時刻より後に、そのエラーが 1 件以上増えている
      ② 前回通知から冷却時間 (既定 60 分) が経っている

    初めて見る fingerprint は冷却なしで即対象になる (最初の 1 通は必ず届く)。
    """
    cfg = settings or alert_settings()
    levels = ["error", "warning"] if cfg.notify_warnings else ["error"]
    rows = (
        await session.execute(
            text(
                "select e.fingerprint, "
                "       count(*) as new_count, "
                "       min(e.occurred_at) as first_seen, "
                "       max(e.occurred_at) as last_seen, "
                "       coalesce(a.notified_count, 0) as notified_count "
                "  from public.error_log e "
                "  left join public.error_alerts a on a.fingerprint = e.fingerprint "
                " where e.level = any(:levels) "
                "   and e.kind <> :skip_kind "
                "   and (a.last_notified_at is null or e.occurred_at > a.last_notified_at) "
                "   and (a.last_notified_at is null "
                "        or a.last_notified_at < now() - make_interval(mins => :cool)) "
                " group by e.fingerprint, a.notified_count "
                " order by max(e.occurred_at) desc "
                " limit :lim"
            ),
            {
                "levels": levels,
                "skip_kind": DELIVERY_FAILED_KIND,
                "cool": cfg.cooldown_minutes,
                "lim": cfg.max_per_run,
            },
        )
    ).all()
    if not rows:
        return []

    out: list[AlertCandidate] = []
    for row in rows:
        latest = (
            await session.execute(
                text(
                    "select kind, message, source, level, path from public.error_log "
                    " where fingerprint = :fp order by occurred_at desc limit 1"
                ),
                {"fp": str(row.fingerprint)},
            )
        ).first()
        if latest is None:  # pragma: no cover - 直前に消えた場合のみ
            continue
        out.append(
            AlertCandidate(
                fingerprint=str(row.fingerprint),
                kind=str(latest.kind),
                message=str(latest.message),
                source=str(latest.source),
                level=str(latest.level),
                path=None if latest.path is None else str(latest.path),
                new_count=int(row.new_count),
                first_seen_at=row.first_seen,
                last_seen_at=row.last_seen,
                notified_count=int(row.notified_count),
            )
        )
    return out


def build_message(candidate: AlertCandidate) -> tuple[str, list[str]]:
    """通知の件名と本文を作る。**推測を書かない** — 記録されている事実だけ。"""
    where = _SOURCE_LABEL.get(candidate.source, candidate.source)
    first_or_again = "新種" if candidate.notified_count == 0 else "継続"
    title = f"{where}でエラー: {candidate.kind}"
    lines = [
        f"内容: {candidate.message}",
        f"発生場所: {where}" + (f" {candidate.path}" if candidate.path else ""),
        f"前回通知以降の件数: {candidate.new_count} 件 ({first_or_again})",
        f"最初に観測: {candidate.first_seen_at:%Y-%m-%d %H:%M} UTC",
        f"最後に観測: {candidate.last_seen_at:%Y-%m-%d %H:%M} UTC",
        f"同種をまとめる key: {candidate.fingerprint}",
    ]
    return title, lines


async def _record(
    session: AsyncSession,
    *,
    candidate: AlertCandidate,
    status: str,
    detail: str,
    advance: bool,
) -> None:
    """通知結果を error_alerts に残す。

    advance=False (配送失敗 / 送信先未設定) のときは last_notified_at を進めない。
    進めてしまうと、届いていないのに「通知済み」になって取りこぼす。
    """
    await session.execute(
        text(
            "insert into public.error_alerts "
            "(fingerprint, first_seen_at, last_notified_at, notified_count, "
            " reported_errors, last_status, last_detail) "
            "values (:fp, :first, case when :adv then now() else null end, "
            "        case when :adv then 1 else 0 end, "
            "        case when :adv then :cnt else 0 end, :st, :dt) "
            "on conflict (fingerprint) do update set "
            "  last_notified_at = case when :adv then now() "
            "                          else public.error_alerts.last_notified_at end, "
            "  notified_count = public.error_alerts.notified_count + case when :adv then 1 else 0 end, "
            "  reported_errors = public.error_alerts.reported_errors "
            "                    + case when :adv then :cnt else 0 end, "
            "  last_status = :st, "
            "  last_detail = :dt"
        ),
        {
            "fp": candidate.fingerprint,
            "first": candidate.first_seen_at,
            "adv": advance,
            "cnt": candidate.new_count,
            "st": status,
            "dt": detail[:500],
        },
    )


async def run_error_alerts(
    session: AsyncSession, *, settings: AlertSettings | None = None
) -> dict[str, str]:
    """cron 本体。通知すべき不具合を探して送り、結果を記録する。"""
    cfg = settings or alert_settings()
    candidates = await find_candidates(session, settings=cfg)
    if not candidates:
        return {"status": "ok", "name": "error-alerts", "candidates": "0", "sent": "0"}

    channels = configured_channels(cfg)
    sent = failed = skipped = 0
    for candidate in candidates:
        if not channels:
            await _record(
                session,
                candidate=candidate,
                status="skipped",
                detail=(
                    "送信先が未設定 (ATELIER_ALERT_EMAIL_TO / ATELIER_ALERT_SLACK_WEBHOOK_URL)"
                ),
                advance=False,
            )
            skipped += 1
            continue
        title, lines = build_message(candidate)
        delivery = await send_alert(title=title, lines=lines, level="error", settings=cfg)
        await _record(
            session,
            candidate=candidate,
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
        logger.warning("error-alerts: %d 件の通知に失敗 (次回再試行)", failed)
    return {
        "status": "ok",
        "name": "error-alerts",
        "candidates": str(len(candidates)),
        "sent": str(sent),
        "failed": str(failed),
        "skipped": str(skipped),
    }


@dataclass(frozen=True)
class AlertStateRow:
    fingerprint: str
    first_seen_at: datetime
    last_notified_at: datetime | None
    notified_count: int
    reported_errors: int
    last_status: str
    last_detail: str | None


async def list_alert_state(*, limit: int = 50) -> list[AlertStateRow]:
    """運営画面 (S-T05) 用: 通知の送信状態を新しい順で返す。"""
    limit = max(1, min(limit, 200))
    async with _service_factory()() as session:
        rows = (
            await session.execute(
                text(
                    "select fingerprint, first_seen_at, last_notified_at, notified_count, "
                    "       reported_errors, last_status, last_detail "
                    "  from public.error_alerts "
                    " order by coalesce(last_notified_at, first_seen_at) desc limit :lim"
                ),
                {"lim": limit},
            )
        ).all()
    return [
        AlertStateRow(
            fingerprint=str(r.fingerprint),
            first_seen_at=r.first_seen_at,
            last_notified_at=r.last_notified_at,
            notified_count=int(r.notified_count),
            reported_errors=int(r.reported_errors),
            last_status=str(r.last_status),
            last_detail=None if r.last_detail is None else str(r.last_detail),
        )
        for r in rows
    ]


__all__ = [
    "DELIVERY_FAILED_KIND",
    "AlertCandidate",
    "AlertStateRow",
    "build_message",
    "find_candidates",
    "list_alert_state",
    "run_error_alerts",
]
