"""サーキットブレーカ + PID ポーリング サービス層 (T-A-29)。

DB を信頼源とした breaker 状態算出 + stale task 回収。

state 決定 (時間窓 window_minutes):
  - total < min_samples → closed (まだ判断不可)
  - failure_rate >= threshold → open
  - その他 → closed

stale task 回収:
  - dispatch_status='running' and (worker_last_heartbeat_at < now - threshold
    OR worker_last_heartbeat_at is null and started > threshold)
  - reclaim: dispatch_status='reclaimed', task_executions.status='timeout'

全 mutating 操作で audit_logs 記録 (actor_type='system', actor_id='breaker'
または actor_type='user' for admin reset)。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.circuit_breaker import (
    CircuitBreakerState,
    CircuitState,
    PidPollResponse,
    PidPollResult,
)

# breaker 評価で「最低限必要な実行数」(これ未満は判断保留 → closed)
_MIN_SAMPLES = 5
_DEFAULT_THRESHOLD = 0.5
_DEFAULT_WINDOW_MINUTES = 15
# half_open → closed への自動復帰までの clock
_OPEN_RETRY_AFTER = timedelta(minutes=5)

# breaker は global singleton。audit 用に固定 UUID を使う (target_id 列が uuid 型)。
_BREAKER_TARGET_ID = "00000000-0000-0000-0000-000000000029"


async def evaluate_breaker(
    session: AsyncSession,
    *,
    window_minutes: int = _DEFAULT_WINDOW_MINUTES,
    threshold: float = _DEFAULT_THRESHOLD,
) -> CircuitBreakerState:
    """直近 window_minutes の task_executions から breaker 状態を算出する。"""
    res = await session.execute(
        text(
            "select count(*) as total, "
            "count(*) filter (where status in ('failed', 'cancelled', 'timeout')) as failed "
            "from public.task_executions "
            "where started_at >= now() - make_interval(mins => :w)"
        ),
        {"w": window_minutes},
    )
    row = res.first()
    total = int(row.total) if row else 0
    failed = int(row.failed) if row else 0
    rate = (failed / total) if total > 0 else 0.0
    now = datetime.now(UTC)

    state: CircuitState
    next_retry: datetime | None = None
    if total < _MIN_SAMPLES:
        state = "closed"
    elif rate >= threshold:
        state = "open"
        next_retry = now + _OPEN_RETRY_AFTER
    else:
        state = "closed"

    return CircuitBreakerState(
        state=state,
        failure_rate=rate,
        total_executions=total,
        failed_executions=failed,
        window_minutes=window_minutes,
        threshold=threshold,
        next_retry_at=next_retry,
        evaluated_at=now,
    )


async def reset_breaker(
    session: AsyncSession, *, actor_id: str, reason: str
) -> CircuitBreakerState:
    """breaker を closed へ強制リセット。

    実 state は DB から動的算出するため reset の意味は「監査ログ + half_open
    の意図を残す」ことに限定し、評価窓の起点を明示せず evaluate と同じ結果
    を返す。reason は audit に必ず記録 (UBIQUITOUS state-changing audit)。
    """
    state = await evaluate_breaker(session)
    await AuditWriter(session).write(
        AuditEvent(
            action="circuit_breaker.reset",
            target_type="circuit_breaker",
            actor_type="user",
            actor_id=actor_id,
            target_id=_BREAKER_TARGET_ID,
            after={
                "reason": reason,
                "evaluated_state": state.state,
                "failure_rate": state.failure_rate,
            },
        )
    )
    return state


async def _find_stale_tasks(session: AsyncSession, *, threshold_seconds: int) -> list[Any]:
    """heartbeat が threshold 秒以上途絶えた running task を返す。"""
    res = await session.execute(
        text(
            "select id, worker_pid, worker_last_heartbeat_at, updated_at "
            "from public.tasks "
            "where dispatch_status = 'running' and deleted_at is null and ("
            "  worker_last_heartbeat_at is not null and "
            "    worker_last_heartbeat_at < now() - make_interval(secs => :s) "
            "  or worker_last_heartbeat_at is null and "
            "    updated_at < now() - make_interval(secs => :s)"
            ")"
        ),
        {"s": threshold_seconds},
    )
    return list(res.all())


async def poll_pids(
    session: AsyncSession,
    *,
    actor_id: str,
    threshold_seconds: int = 60,
    dry_run: bool = False,
) -> PidPollResponse:
    """PID ポーリング: stale な running task を見つけ reclaim する。

    dry_run=True なら一覧返却のみで DB 不更新。それ以外は dispatch_status
    を 'reclaimed' に遷移、task_executions の最新 running 行を timeout に
    更新する。各 reclaim 操作は audit_logs に記録。
    """
    stale_rows = await _find_stale_tasks(session, threshold_seconds=threshold_seconds)
    now = datetime.now(UTC)
    results: list[PidPollResult] = []
    for row in stale_rows:
        task_id = str(row.id)
        wpid = None if row.worker_pid is None else int(row.worker_pid)
        last_hb = row.worker_last_heartbeat_at
        if dry_run:
            results.append(
                PidPollResult(
                    task_id=task_id,
                    worker_pid=wpid,
                    last_heartbeat_at=last_hb,
                    action="dry_run_would_reclaim",
                )
            )
            continue

        await session.execute(
            text(
                "update public.tasks set dispatch_status = 'reclaimed', "
                "lifecycle_stage = 'blocked', worker_pid = null, "
                "blocked_reason = 'PID heartbeat timeout (reclaimed by circuit_breaker)', "
                "updated_at = now() "
                "where id = cast(:t as uuid)"
            ),
            {"t": task_id},
        )
        await session.execute(
            text(
                "update public.task_executions set completed_at = now(), "
                "status = 'timeout', error_summary = 'heartbeat timeout' "
                "where task_id = cast(:t as uuid) and status = 'running'"
            ),
            {"t": task_id},
        )
        await AuditWriter(session).write(
            AuditEvent(
                action="circuit_breaker.pid_reclaim",
                target_type="task",
                actor_type="user",
                actor_id=actor_id,
                target_id=task_id,
                after={
                    "worker_pid": wpid,
                    "threshold_seconds": threshold_seconds,
                    "last_heartbeat_at": (None if last_hb is None else last_hb.isoformat()),
                    "triggered_by": "circuit_breaker",
                },
            )
        )
        results.append(
            PidPollResult(
                task_id=task_id,
                worker_pid=wpid,
                last_heartbeat_at=last_hb,
                action="reclaimed",
            )
        )

    return PidPollResponse(
        polled_at=now,
        threshold_seconds=threshold_seconds,
        stale_task_count=len(results),
        results=results,
    )
