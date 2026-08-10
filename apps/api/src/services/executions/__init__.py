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

from src.audit import AuditEvent, AuditWriter
from src.schemas.executions import (
    BridgeStatusResponse,
    BridgeWorkerInfo,
    DispatchControlResponse,
    DispatchPromoteResponse,
    ExecutionEvent,
    ExecutionResponse,
    ExecutionStatus,
    ExecutionTestResult,
)


class DispatchOpsError(Exception):
    """S-I03 運用操作 (GAP-026) の構造的失敗。code で分岐する。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


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

    # GAP-026: 一時停止フラグ + Bridge presence (直近 5 分の ping)
    paused_res = await session.execute(
        text("select paused from public.dispatch_control where id = 1")
    )
    paused = bool(paused_res.scalar_one_or_none())
    workers_res = await session.execute(
        text(
            "select id, host_label, version, worker_pid, last_seen_at, "
            "(last_seen_at >= now() - interval '90 seconds') as connected "
            "from public.bridge_workers "
            "where last_seen_at >= now() - interval '5 minutes' "
            "order by last_seen_at desc"
        )
    )
    workers = [
        BridgeWorkerInfo(
            id=str(r.id),
            host_label=str(r.host_label),
            version=str(r.version),
            worker_pid=(None if r.worker_pid is None else int(r.worker_pid)),
            last_seen_at=r.last_seen_at,
            connected=bool(r.connected),
        )
        for r in workers_res.all()
    ]

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
        paused=paused,
        workers=workers,
    )


async def set_dispatch_paused(
    session: AsyncSession, *, actor_id: str, paused: bool
) -> DispatchControlResponse:
    """「すべて一時停止 / 再開」(GAP-026②)。

    paused=true の間、Bridge の /kanban/pick は新規タスクを掴まない
    (実行中のセッションは止めない — モックの説明どおり「新規開始の停止」)。
    """
    await session.execute(
        text(
            "update public.dispatch_control set paused = :p, "
            "paused_by = case when :p then cast(:u as uuid) else null end, "
            "paused_at = case when :p then now() else null end, "
            "updated_at = now() where id = 1"
        ),
        {"p": paused, "u": actor_id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="dispatch.paused" if paused else "dispatch.resumed",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id="dispatch-control",
        )
    )
    res = await session.execute(
        text("select paused, paused_at, paused_by from public.dispatch_control where id = 1")
    )
    row = res.first()
    return DispatchControlResponse(
        paused=bool(row.paused) if row else paused,
        paused_at=(row.paused_at if row else None),
        paused_by=(None if row is None or row.paused_by is None else str(row.paused_by)),
    )


async def promote_next_queued(
    session: AsyncSession, *, actor_id: str, task_id: str | None = None
) -> DispatchPromoteResponse:
    """「順番待ちから 1 件追加」(GAP-026②)。

    指定 (または最古の) queued タスクを昇格し、次の pick で最優先に選ばせる。
    Bridge がローカルで worker を起動する構造のため、API 側で spawn は
    しない (昇格 = 次の空き枠で最優先開始)。queued が無ければ no_queued。
    """
    where = ["dispatch_status = 'queued'", "deleted_at is null"]
    params: dict[str, object] = {}
    if task_id is not None:
        where.append("id = cast(:tid as uuid)")
        params["tid"] = task_id
    res = await session.execute(
        text(
            "update public.tasks set dispatch_promoted_at = now(), updated_at = now() "
            "where id = (select id from public.tasks "
            f"  where {' and '.join(where)} "
            "  order by dispatch_promoted_at desc nulls last, created_at limit 1) "
            "returning id, title"
        ),
        params,
    )
    row = res.first()
    if row is None:
        raise DispatchOpsError("no_queued", "no queued task to promote")
    await AuditWriter(session).write(
        AuditEvent(
            action="dispatch.promoted",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=str(row.id),
        )
    )
    return DispatchPromoteResponse(
        task_id=str(row.id),
        title=str(row.title),
        note=f"「{row.title}」を次の空き枠で最優先開始します",
    )


async def cancel_queued_dispatch(session: AsyncSession, *, actor_id: str, task_id: str) -> bool:
    """「キュー取消」(GAP-026③)。queued のみ対象 — dispatch_status を解除する。

    返り値 False = タスク不可視/不在 (404)。queued 以外は invalid_state (409)。
    """
    res = await session.execute(
        text(
            "select dispatch_status from public.tasks "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": task_id},
    )
    row = res.first()
    if row is None:
        return False
    if str(row.dispatch_status or "") != "queued":
        raise DispatchOpsError(
            "invalid_state", f"task is not queued (dispatch_status={row.dispatch_status})"
        )
    await session.execute(
        text(
            "update public.tasks set dispatch_status = null, dispatch_promoted_at = null, "
            "lifecycle_stage = 'ready', updated_at = now() where id = cast(:id as uuid)"
        ),
        {"id": task_id},
    )
    # play_task 投入時に作られた running execution が残っていれば取消で閉じる
    await session.execute(
        text(
            "update public.task_executions set status = 'cancelled', completed_at = now(), "
            "error_summary = 'S-I03 からキュー取消' "
            "where task_id = cast(:id as uuid) and status = 'running'"
        ),
        {"id": task_id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="dispatch.cancelled",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
        )
    )
    return True


async def stop_dispatch(session: AsyncSession, *, actor_id: str, task_id: str) -> bool:
    """「セッション停止」(GAP-026④)。spawning/running/completing を対象に
    dispatch_status='reclaimed' + 実行中 execution を cancelled で閉じる。

    ローカル worker 自体は Bridge 側プロセスのため即殺はできないが、以後の
    heartbeat/complete は reclaimed 状態で拒否され、成果は取り込まれない
    (kanban.kill と同じ終端状態)。返り値 False = 不可視/不在 (404)。
    """
    res = await session.execute(
        text(
            "select dispatch_status from public.tasks "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": task_id},
    )
    row = res.first()
    if row is None:
        return False
    if str(row.dispatch_status or "") not in ("spawning", "running", "completing"):
        raise DispatchOpsError(
            "invalid_state",
            f"task is not running (dispatch_status={row.dispatch_status})",
        )
    await session.execute(
        text(
            "update public.tasks set dispatch_status = 'reclaimed', "
            "lifecycle_stage = 'blocked', blocked_reason = 'S-I03 から手動停止', "
            "worker_pid = null, updated_at = now() where id = cast(:id as uuid)"
        ),
        {"id": task_id},
    )
    await session.execute(
        text(
            "update public.task_executions set status = 'cancelled', completed_at = now(), "
            "error_summary = 'S-I03 から手動停止' "
            "where task_id = cast(:id as uuid) and status = 'running'"
        ),
        {"id": task_id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="dispatch.stopped",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
        )
    )
    return True


async def list_execution_events(session: AsyncSession, *, limit: int = 50) -> list[ExecutionEvent]:
    """ログ集約ビュー (GAP-026⑤) — 実 task_executions から導出したイベント列。

    1 execution から「開始」+「終了 (status)」の最大 2 イベントを起こし、
    新しい順に limit 件。RLS で可視な task のみ。推測ログは生成しない。
    """
    res = await session.execute(
        text(
            "select ev.at, ev.kind, ev.execution_id, ev.task_id, ev.task_title, "
            "ev.score, ev.error_summary from ("
            "  select te.started_at as at, 'started' as kind, te.id as execution_id, "
            "         t.id as task_id, t.title as task_title, "
            "         null::numeric as score, null::text as error_summary "
            "  from public.task_executions te join public.tasks t on t.id = te.task_id "
            "  where t.deleted_at is null "
            "  union all "
            "  select te.completed_at, te.status::text, te.id, t.id, t.title, "
            "         te.score, te.error_summary "
            "  from public.task_executions te join public.tasks t on t.id = te.task_id "
            "  where t.deleted_at is null and te.completed_at is not null "
            ") ev order by ev.at desc limit :lim"
        ),
        {"lim": limit},
    )
    return [
        ExecutionEvent(
            at=r.at,
            kind=str(r.kind),
            execution_id=str(r.execution_id),
            task_id=str(r.task_id),
            task_title=str(r.task_title),
            score=(None if r.score is None else float(r.score)),
            error_summary=(None if r.error_summary is None else str(r.error_summary)),
        )
        for r in res.all()
    ]


async def list_execution_tests(
    session: AsyncSession, *, execution_id: str
) -> list[ExecutionTestResult] | None:
    """テストケース単位の結果 (GAP-025② — RLS で task 経由に scope)。

    返り値 None = execution 不可視/不在 (404)。
    """
    if await get_execution(session, execution_id) is None:
        return None
    res = await session.execute(
        text(
            "select id, execution_id, name, file, status, duration_ms, detail, created_at "
            "from public.task_execution_tests "
            "where execution_id = cast(:eid as uuid) order by created_at, id"
        ),
        {"eid": execution_id},
    )
    return [
        ExecutionTestResult(
            id=str(r.id),
            execution_id=str(r.execution_id),
            name=str(r.name),
            file=(None if r.file is None else str(r.file)),
            status=str(r.status),
            duration_ms=(None if r.duration_ms is None else int(r.duration_ms)),
            detail=(None if r.detail is None else str(r.detail)),
            created_at=r.created_at,
        )
        for r in res.all()
    ]
