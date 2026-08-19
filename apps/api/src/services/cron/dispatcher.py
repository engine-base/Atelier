"""GAP-179: 利用者が作った自動実行を、利用者が指定した時刻に実際に走らせる。

**これまでの実態**: `cron_schedules` は保存されるだけで、そこに書かれた
cron 式を見て何かを起動するコードが存在しなかった。唯一動いていた
`daily_digest` も、発火のきっかけはプラットフォーム固定の 22:00 UTC であり、
利用者が画面で指定した時刻は使われていなかった。

GAP-183 (経営者判断 2026-08-19): 発火の「見張り役」は **利用者の PC (Bridge) が主、
クラウドの 15 分 cron が滑り止め**。クラウド側に毎分起きる cron を置くと Fly.io の
アイドル停止が効かなくなり、使っていなくても運営に固定費が発生する。Bridge が
動いている間はそちらが叩き、PC がスリープしていた間に過ぎた分は**起動した時点で
まとめて実行**される (next_run_at <= now() を拾う設計なのでそのまま成立する)。

**二重実行の防止**: 見張り役が 2 つある以上、PC と クラウドが同じ行を同時に
拾いうる。AI を使う自動実行が二重に走ると利用者のプラン枠を無駄に消費するため、
発火対象は `for update skip locked` で 1 行ずつロックして取り、next_run_at を
先に進めてから実行する。ロックを取れなかった行は「他方が処理中」なので黙って飛ばす。

「今は実行できない」(PC 未接続など) 場合は失敗にせず `deferred` として記録し、
短い間隔で再試行する (GAP-177 と同じ方針)。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .actions import ActionOutcome, get_action_spec
from .expression import CronExpressionError, next_occurrence

logger = logging.getLogger(__name__)

UTC = ZoneInfo("UTC")

#: 保留 (PC 未接続など) のときの再試行間隔。
RETRY_AFTER_MINUTES = 10

#: GAP-184: プラン枠の上限で保留したときの再試行間隔。5 時間枠のリセットを
#: 待つ必要があるので、10 分ごとに叩き続けても無駄 (かつ枠を消費しかねない)。
RATE_LIMIT_RETRY_MINUTES = 30


async def compute_next_run(
    session: AsyncSession, *, schedule_id: str, expression: str, after: datetime
) -> datetime | None:
    """next_run_at を計算して保存する。式が不正なら null にして理由をログに残す。"""
    try:
        nxt = next_occurrence(expression, after=after)
    except CronExpressionError as exc:
        logger.warning("cron schedule %s has invalid expression: %s", schedule_id, exc)
        await session.execute(
            text("update public.cron_schedules set next_run_at = null where id = cast(:i as uuid)"),
            {"i": schedule_id},
        )
        return None
    await session.execute(
        text("update public.cron_schedules set next_run_at = :n where id = cast(:i as uuid)"),
        {"i": schedule_id, "n": nxt},
    )
    return nxt


async def _record_start(
    session: AsyncSession, *, name: str, schedule_id: str, project_id: str
) -> str | None:
    try:
        res = await session.execute(
            text(
                "insert into public.cron_run_history (name, schedule_id, project_id, status) "
                "values (:n, cast(:s as uuid), cast(:p as uuid), 'running') returning id"
            ),
            {"n": name, "s": schedule_id, "p": project_id},
        )
        return str(res.scalar_one())
    except Exception:  # pragma: no cover - 履歴が書けなくても本体は止めない
        logger.exception("cron_run_history insert failed for schedule %s", schedule_id)
        return None


async def _record_finish(
    session: AsyncSession, *, run_id: str | None, status: str, detail: dict[str, Any]
) -> None:
    if run_id is None:
        return
    try:
        await session.execute(
            text(
                "update public.cron_run_history set status = :st, finished_at = now(), "
                "detail = cast(:d as jsonb) where id = cast(:i as uuid)"
            ),
            {"i": run_id, "st": status, "d": json.dumps(detail, ensure_ascii=False)},
        )
    except Exception:  # pragma: no cover
        logger.exception("cron_run_history finish failed for %s", run_id)


async def _record_failure(
    session: AsyncSession,
    *,
    name: str,
    schedule_id: str,
    project_id: str,
    error: str,
) -> None:
    """失敗を 1 行で記録する (rollback 後に使う)。"""
    try:
        await session.execute(
            text(
                "insert into public.cron_run_history "
                "(name, schedule_id, project_id, status, finished_at, detail) "
                "values (:n, cast(:s as uuid), cast(:p as uuid), 'error', now(), "
                " cast(:d as jsonb))"
            ),
            {
                "n": name,
                "s": schedule_id,
                "p": project_id,
                "d": json.dumps({"error": error}, ensure_ascii=False),
            },
        )
    except Exception:  # pragma: no cover
        logger.exception("cron_run_history failure insert failed for %s", schedule_id)


async def run_due_schedules(
    session: AsyncSession,
    *,
    now: datetime | None = None,
    complete: Any = None,
    user_id: str | None = None,
) -> dict[str, int]:
    """発火時刻を過ぎた利用者スケジュールを実行する。

    user_id を渡すと **その人が所属する workspace のプロジェクト**のスケジュールだけを
    対象にする (GAP-183: 各利用者の PC が自分の分だけを回す。他社の予定を
    他人の PC が動かさない)。None なら全件 (セルフホスト / 運営バッチ用)。

    Returns: {"due": n, "ran": n, "deferred": n, "failed": n, "scheduled": n}
      scheduled = next_run_at が未計算だったので今回は計算だけした件数
    """
    current = now or datetime.now(tz=UTC)
    where = ["enabled = true"]
    params: dict[str, Any] = {}
    if user_id is not None:
        where.append(
            "project_id in (select p.id from public.projects p "
            "join public.workspace_memberships m on m.workspace_id = p.workspace_id "
            "where m.user_id = cast(:uid as uuid))"
        )
        params["uid"] = user_id
    # skip locked: もう一方の見張り役 (PC / クラウド) が処理中の行は飛ばす。
    rows = (
        await session.execute(
            text(
                "select id, project_id, name, cron_expression, target_action, "
                "target_payload, next_run_at from public.cron_schedules "
                f"where {' and '.join(where)} order by created_at for update skip locked"
            ),
            params,
        )
    ).all()

    stats = {"due": 0, "ran": 0, "deferred": 0, "failed": 0, "scheduled": 0}
    for row in rows:
        schedule_id = str(row.id)
        if row.next_run_at is None:
            # 初回 (または式変更直後)。次回時刻を確定するだけで今回は動かさない。
            if await compute_next_run(
                session,
                schedule_id=schedule_id,
                expression=str(row.cron_expression),
                after=current,
            ):
                stats["scheduled"] += 1
            continue
        due_at: datetime = row.next_run_at
        if due_at.tzinfo is None:
            due_at = due_at.replace(tzinfo=UTC)
        if due_at > current:
            continue

        stats["due"] += 1
        action = str(row.target_action)
        spec = get_action_spec(action)
        # 実行**前**に次回時刻を進める。ここで確定させておかないと、実行中に
        # もう一方の見張り役が同じ行を拾って二重実行になる。
        await compute_next_run(
            session,
            schedule_id=schedule_id,
            expression=str(row.cron_expression),
            after=current,
        )
        run_id = await _record_start(
            session, name=str(row.name), schedule_id=schedule_id, project_id=str(row.project_id)
        )
        if spec is None:
            # 未知の action。嘘の success を書かない。
            await _record_finish(
                session,
                run_id=run_id,
                status="error",
                detail={"error": f"unknown target_action: {action}"},
            )
            stats["failed"] += 1
            await compute_next_run(
                session,
                schedule_id=schedule_id,
                expression=str(row.cron_expression),
                after=current,
            )
            continue

        payload_raw: Any = row.target_payload
        payload: dict[str, Any] = (
            json.loads(payload_raw) if isinstance(payload_raw, str) else (payload_raw or {})
        )
        try:
            outcome: ActionOutcome = await spec.run(
                session,
                project_id=str(row.project_id),
                payload=payload,
                complete=complete,
            )
        except Exception as exc:  # 1 件の失敗で他のスケジュールを巻き添えにしない
            logger.exception("cron schedule %s (%s) failed", schedule_id, action)
            # DB エラーだとトランザクションが壊れている。巻き戻してから履歴を書く
            # (ここで rollback しないと「失敗した」ことすら記録できない)。
            await session.rollback()
            await _record_failure(
                session,
                name=str(row.name),
                schedule_id=schedule_id,
                project_id=str(row.project_id),
                error=str(exc)[:300],
            )
            stats["failed"] += 1
            await compute_next_run(
                session,
                schedule_id=schedule_id,
                expression=str(row.cron_expression),
                after=current,
            )
            await session.commit()
            continue

        detail: dict[str, Any] = dict(outcome.detail)
        if outcome.reason:
            detail["reason"] = outcome.reason
        if outcome.status == "deferred":
            stats["deferred"] += 1
            await _record_finish(session, run_id=run_id, status="deferred", detail=detail)

            # 次の定刻より早く再試行する (PC を起動したらすぐ動く)。
            # ただしプラン枠の上限はリセット待ちなので間隔を空ける (GAP-184)。
            wait_minutes = (
                RATE_LIMIT_RETRY_MINUTES
                if outcome.reason == "rate_limited"
                else RETRY_AFTER_MINUTES
            )
            retry_at = current + timedelta(minutes=wait_minutes)
            try:
                scheduled_next = next_occurrence(str(row.cron_expression), after=current)
                retry_at = min(retry_at, scheduled_next)
            except CronExpressionError:
                pass
            await session.execute(
                text(
                    "update public.cron_schedules set next_run_at = :n where id = cast(:i as uuid)"
                ),
                {"i": schedule_id, "n": retry_at},
            )
            await session.commit()
        else:
            stats["ran"] += 1
            await _record_finish(session, run_id=run_id, status="success", detail=detail)
            await compute_next_run(
                session,
                schedule_id=schedule_id,
                expression=str(row.cron_expression),
                after=current,
            )
            await session.commit()
    await session.commit()
    if stats["due"] or stats["scheduled"]:
        logger.info("user cron schedules processed: %s", stats)
    return stats


__all__ = ["RETRY_AFTER_MINUTES", "compute_next_run", "run_due_schedules"]
