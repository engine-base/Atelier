"""実行モニター + Bridge 状態 サービス層 (T-A-30)。

E-013 task_executions を信頼源とし、tasks (E-012) と join して title /
worker_pid / dispatch_status を返す。可視性は RLS (T-D-16) で tasks 経由に
scope される。状態変更無し (read-only)。

Bridge 状態は tasks.dispatch_status + task_executions.status から動的算出。
parallel_limit は T-A-24 と整合する _PARALLEL_LIMIT を信頼源。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.executions import (
    BridgeStatusResponse,
    ExecutionResponse,
    ExecutionStatus,
)

# T-A-24 の _PARALLEL_LIMIT と整合させる (Bridge worker 並列上限)
_PARALLEL_LIMIT = 5

_SELECT_COLS = (
    "te.id, te.task_id, t.title as task_title, t.project_id, "
    "te.started_at, te.completed_at, "
    "extract(epoch from (coalesce(te.completed_at, now()) - te.started_at)) as duration_seconds, "
    "te.status, te.score, te.ac_pass_rate, te.test_pass_rate, te.verification_score, "
    "te.retry_count, te.claude_code_session_id, te.logs_storage_path, te.error_summary, "
    "t.worker_pid, t.dispatch_status, te.created_at"
)


def _row_to_response(row: Any) -> ExecutionResponse:
    return ExecutionResponse(
        id=str(row.id),
        task_id=str(row.task_id),
        task_title=str(row.task_title),
        project_id=str(row.project_id),
        started_at=row.started_at,
        completed_at=row.completed_at,
        duration_seconds=(None if row.duration_seconds is None else float(row.duration_seconds)),
        status=str(row.status),  # type: ignore[arg-type]
        score=(None if row.score is None else float(row.score)),
        ac_pass_rate=(None if row.ac_pass_rate is None else float(row.ac_pass_rate)),
        test_pass_rate=(None if row.test_pass_rate is None else float(row.test_pass_rate)),
        verification_score=(
            None if row.verification_score is None else float(row.verification_score)
        ),
        retry_count=int(row.retry_count),
        claude_code_session_id=(
            None if row.claude_code_session_id is None else str(row.claude_code_session_id)
        ),
        logs_storage_path=(None if row.logs_storage_path is None else str(row.logs_storage_path)),
        error_summary=(None if row.error_summary is None else str(row.error_summary)),
        worker_pid=(None if row.worker_pid is None else int(row.worker_pid)),
        dispatch_status=(None if row.dispatch_status is None else str(row.dispatch_status)),
        created_at=row.created_at,
    )


async def list_executions(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    task_id: str | None = None,
    status_filter: ExecutionStatus | None = None,
    limit: int = 50,
    offset: int = 0,
) -> list[ExecutionResponse]:
    """task_executions 横断一覧。RLS で tasks 経由に scope される。

    task が論理削除 (deleted_at) されたものは除外する。
    """
    where = ["t.deleted_at is null"]
    params: dict[str, object] = {"lim": limit, "off": offset}
    if project_id is not None:
        where.append("t.project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if task_id is not None:
        where.append("te.task_id = cast(:tid as uuid)")
        params["tid"] = task_id
    if status_filter is not None:
        where.append("te.status = cast(:st as task_execution_status_enum)")
        params["st"] = status_filter
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.task_executions te "
            "join public.tasks t on t.id = te.task_id "
            f"where {' and '.join(where)} "
            "order by te.started_at desc limit :lim offset :off"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_execution(session: AsyncSession, execution_id: str) -> ExecutionResponse | None:
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.task_executions te "
            "join public.tasks t on t.id = te.task_id "
            "where te.id = cast(:eid as uuid) and t.deleted_at is null"
        ),
        {"eid": execution_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def bridge_status(session: AsyncSession) -> BridgeStatusResponse:
    """Bridge 集約状態。RLS の効いた tasks / task_executions から動的算出。

    24h 内の dead_count は dispatch_status in (dead, reclaimed) を集計。
    """
    res = await session.execute(
        text(
            "select "
            "count(*) filter (where dispatch_status = 'running') as running_count, "
            "count(*) filter (where dispatch_status = 'queued') as queued_count, "
            "count(*) filter (where dispatch_status = 'completing') as completing_count, "
            "count(*) filter (where dispatch_status = 'spawning') as spawning_count, "
            "count(*) filter (where dispatch_status in ('dead', 'reclaimed') "
            "  and updated_at >= now() - interval '24 hours') as dead_count_24h "
            "from public.tasks where deleted_at is null"
        )
    )
    row = res.first()
    running = int(row.running_count) if row else 0
    queued = int(row.queued_count) if row else 0
    completing = int(row.completing_count) if row else 0
    spawning = int(row.spawning_count) if row else 0
    dead = int(row.dead_count_24h) if row else 0

    oldest_res = await session.execute(
        text(
            "select min(te.started_at) as oldest from public.task_executions te "
            "join public.tasks t on t.id = te.task_id "
            "where te.status = 'running' and t.deleted_at is null"
        )
    )
    oldest_row = oldest_res.first()
    oldest = oldest_row.oldest if oldest_row else None

    pid_res = await session.execute(
        text(
            "select distinct worker_pid from public.tasks "
            "where dispatch_status = 'running' and worker_pid is not null "
            "and deleted_at is null order by worker_pid"
        )
    )
    pids = [int(r.worker_pid) for r in pid_res.all()]

    return BridgeStatusResponse(
        running_count=running,
        queued_count=queued,
        completing_count=completing,
        spawning_count=spawning,
        dead_count_24h=dead,
        parallel_limit=_PARALLEL_LIMIT,
        available_slots=max(0, _PARALLEL_LIMIT - running),
        oldest_running_started_at=oldest,
        active_worker_pids=pids,
        evaluated_at=datetime.now(UTC),
    )
