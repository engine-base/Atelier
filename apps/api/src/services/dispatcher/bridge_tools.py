"""Hermes 互換 kanban_tools サービス層 (T-A-28)。

Bridge worker (F-BRIDGE01) からの 7 ツールを実装。Bridge token 認証で
service_role 相当のフルアクセス session を受ける (RLS バイパス、worker は
全 workspace の queued task を pick できる)。

各操作は audit_logs に必ず記録 (actor_type='system', actor_id='bridge')。

7 ツール:
- pick           : queued task を 1 件確保 → spawning
- start          : spawning → running、worker_pid / claude_code_session_id
- complete       : running → done|awaiting (auto_approve とスコア依存)
- request_review : running → awaiting (人レビュー要求)
- request_change : running → blocked (差戻、blocked_reason)
- heartbeat      : worker_last_heartbeat_at 更新 (dead-man switch)
- kill           : 強制終了 → dispatch_status=reclaimed, execution=cancelled

T-F-28 (apps/api/src/services/dispatcher/kanban_tools.py) は in-memory な
state machine ドメイン層。本モジュールは HTTP / DB 層で、両者は責務を分離。
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.dispatcher import (
    KanbanCompleteMetadata,
    KanbanResponse,
)

# auto_approve 時に done 確定する閾値 (Hermes と同等)
_AUTO_APPROVE_SCORE_THRESHOLD = 0.95


class DispatcherError(Exception):
    """dispatcher 操作で context が不一致 / 状態不整合の汎用例外。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _audit(
    session: AsyncSession,
    *,
    action: str,
    target_id: str,
    after: dict[str, object] | None = None,
) -> None:
    await AuditWriter(session).write(
        AuditEvent(
            action=action,
            target_type="task",
            actor_type="system",
            actor_id="bridge",
            target_id=target_id,
            after=after,
        )
    )


async def _get_task_row(session: AsyncSession, task_id: str) -> Any:
    res = await session.execute(
        text(
            "select id, project_id, lifecycle_stage, dispatch_status, "
            "retry_count, worktree_path, worker_pid from public.tasks "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": task_id},
    )
    return res.first()


async def pick_task(
    session: AsyncSession,
    *,
    worker_pid: int,
    project_id: str | None = None,
) -> tuple[KanbanResponse | None, str | None, str | None]:
    """次に処理可能な queued task を 1 件 atomic に確保 (queued→spawning)。

    返り値: (KanbanResponse | None, execution_id | None, worktree_path | None)。
    no_available_task の時は (None, None, None) を返す。
    """
    where = ["dispatch_status = 'queued'", "deleted_at is null"]
    params: dict[str, object] = {"pid_w": worker_pid}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    res = await session.execute(
        text(
            "with picked as ("
            "  select id from public.tasks "
            f"  where {' and '.join(where)} "
            "  order by created_at limit 1 for update skip locked"
            ") update public.tasks set dispatch_status = 'spawning', "
            "worker_pid = :pid_w, updated_at = now() "
            "where id in (select id from picked) returning id, project_id, "
            "retry_count, worktree_path"
        ),
        params,
    )
    row = res.first()
    if row is None:
        return None, None, None
    task_id = str(row.id)
    exec_res = await session.execute(
        text(
            "insert into public.task_executions "
            "(task_id, started_at, retry_count, status) "
            "values (cast(:tid as uuid), now(), :rc, 'running') returning id"
        ),
        {"tid": task_id, "rc": int(row.retry_count)},
    )
    exec_id = str(exec_res.scalar_one())
    await _audit(
        session,
        action="kanban.pick",
        target_id=task_id,
        after={"worker_pid": worker_pid, "execution_id": exec_id},
    )
    return (
        KanbanResponse(
            task_id=task_id,
            lifecycle_stage="in_progress",
            dispatch_status="spawning",
            execution_status="running",
            action="picked",
        ),
        exec_id,
        (None if row.worktree_path is None else str(row.worktree_path)),
    )


async def start_task(
    session: AsyncSession,
    *,
    task_id: str,
    execution_id: str,
    worker_pid: int,
    claude_code_session_id: str | None,
) -> KanbanResponse:
    """spawning → running。worker_pid / claude_code_session_id を確定。"""
    row = await _get_task_row(session, task_id)
    if row is None:
        raise DispatcherError("not_found", "task not found")
    if str(row.dispatch_status) not in ("spawning", "queued"):
        raise DispatcherError(
            "invalid_state",
            f"task dispatch_status is {row.dispatch_status}, cannot start",
        )
    await session.execute(
        text(
            "update public.tasks set lifecycle_stage = 'in_progress', "
            "dispatch_status = 'running', worker_pid = :wp, updated_at = now() "
            "where id = cast(:id as uuid)"
        ),
        {"wp": worker_pid, "id": task_id},
    )
    await session.execute(
        text(
            "update public.task_executions set "
            "claude_code_session_id = :cs "
            "where id = cast(:eid as uuid) and task_id = cast(:tid as uuid)"
        ),
        {"cs": claude_code_session_id, "eid": execution_id, "tid": task_id},
    )
    await _audit(
        session,
        action="kanban.start",
        target_id=task_id,
        after={
            "execution_id": execution_id,
            "worker_pid": worker_pid,
            "claude_code_session_id": claude_code_session_id,
        },
    )
    return KanbanResponse(
        task_id=task_id,
        lifecycle_stage="in_progress",
        dispatch_status="running",
        execution_status="running",
        action="started",
    )


async def complete_task(
    session: AsyncSession,
    *,
    task_id: str,
    execution_id: str,
    summary: str,
    metadata: KanbanCompleteMetadata,
    auto_approve: bool,
) -> KanbanResponse:
    """running → done or awaiting。score 閾値 + auto_approve で確定判定。"""
    row = await _get_task_row(session, task_id)
    if row is None:
        raise DispatcherError("not_found", "task not found")
    if str(row.dispatch_status) not in ("running", "completing"):
        raise DispatcherError(
            "invalid_state",
            f"task dispatch_status is {row.dispatch_status}, cannot complete",
        )

    final_done = auto_approve and metadata.score >= _AUTO_APPROVE_SCORE_THRESHOLD
    new_lifecycle = "done" if final_done else "awaiting"

    await session.execute(
        text(
            "update public.tasks set "
            "lifecycle_stage = cast(:ls as task_lifecycle_enum), "
            "dispatch_status = 'completing', summary = :sm, "
            "metadata = cast(:mt as jsonb), updated_at = now() "
            "where id = cast(:id as uuid)"
        ),
        {
            "ls": new_lifecycle,
            "sm": summary,
            "mt": json.dumps(
                {
                    "score": metadata.score,
                    "ac_pass_rate": metadata.ac_pass_rate,
                    "test_pass_rate": metadata.test_pass_rate,
                    "verification_score": metadata.verification_score,
                    "files_changed": metadata.files_changed,
                }
            ),
            "id": task_id,
        },
    )
    await session.execute(
        text(
            "update public.task_executions set completed_at = now(), "
            "score = :sc, ac_pass_rate = :ac, test_pass_rate = :tp, "
            "verification_score = :vs, retry_count = :rc, status = 'succeeded' "
            "where id = cast(:eid as uuid) and task_id = cast(:tid as uuid)"
        ),
        {
            "sc": metadata.score,
            "ac": metadata.ac_pass_rate,
            "tp": metadata.test_pass_rate,
            "vs": metadata.verification_score,
            "rc": metadata.retry_count,
            "eid": execution_id,
            "tid": task_id,
        },
    )
    await _audit(
        session,
        action="kanban.complete",
        target_id=task_id,
        after={
            "execution_id": execution_id,
            "score": metadata.score,
            "auto_approve": auto_approve,
            "final_lifecycle": new_lifecycle,
        },
    )
    return KanbanResponse(
        task_id=task_id,
        lifecycle_stage=new_lifecycle,
        dispatch_status="completing",
        execution_status="succeeded",
        action="completed",
    )


async def request_review(
    session: AsyncSession,
    *,
    task_id: str,
    execution_id: str,
    note: str | None,
) -> KanbanResponse:
    """running → awaiting (人レビュー要求)。"""
    row = await _get_task_row(session, task_id)
    if row is None:
        raise DispatcherError("not_found", "task not found")
    if str(row.dispatch_status) not in ("running", "completing"):
        raise DispatcherError(
            "invalid_state",
            f"task dispatch_status is {row.dispatch_status}, cannot request_review",
        )
    await session.execute(
        text(
            "update public.tasks set lifecycle_stage = 'awaiting', "
            "summary = coalesce(:nt, summary), updated_at = now() "
            "where id = cast(:id as uuid)"
        ),
        {"nt": note, "id": task_id},
    )
    await _audit(
        session,
        action="kanban.request_review",
        target_id=task_id,
        after={"execution_id": execution_id, "note": note},
    )
    return KanbanResponse(
        task_id=task_id,
        lifecycle_stage="awaiting",
        dispatch_status=str(row.dispatch_status),
        action="review_requested",
    )


async def request_change(
    session: AsyncSession,
    *,
    task_id: str,
    execution_id: str,
    reason: str,
) -> KanbanResponse:
    """running → blocked (差戻、blocked_reason)。"""
    row = await _get_task_row(session, task_id)
    if row is None:
        raise DispatcherError("not_found", "task not found")
    if str(row.dispatch_status) not in ("running", "completing"):
        raise DispatcherError(
            "invalid_state",
            f"task dispatch_status is {row.dispatch_status}, cannot request_change",
        )
    await session.execute(
        text(
            "update public.tasks set lifecycle_stage = 'blocked', "
            "blocked_reason = :rs, updated_at = now() "
            "where id = cast(:id as uuid)"
        ),
        {"rs": reason, "id": task_id},
    )
    await session.execute(
        text(
            "update public.task_executions set completed_at = now(), "
            "status = 'failed', error_summary = :rs "
            "where id = cast(:eid as uuid) and task_id = cast(:tid as uuid)"
        ),
        {"rs": reason, "eid": execution_id, "tid": task_id},
    )
    await _audit(
        session,
        action="kanban.request_change",
        target_id=task_id,
        after={"execution_id": execution_id, "reason": reason},
    )
    return KanbanResponse(
        task_id=task_id,
        lifecycle_stage="blocked",
        dispatch_status=str(row.dispatch_status),
        execution_status="failed",
        action="change_requested",
    )


async def heartbeat(session: AsyncSession, *, task_id: str, worker_pid: int) -> KanbanResponse:
    """worker heartbeat。worker_last_heartbeat_at を now() に更新。"""
    res = await session.execute(
        text(
            "update public.tasks set "
            "worker_last_heartbeat_at = now(), updated_at = now() "
            "where id = cast(:id as uuid) and worker_pid = :wp "
            "and deleted_at is null "
            "returning id, lifecycle_stage, dispatch_status"
        ),
        {"id": task_id, "wp": worker_pid},
    )
    row = res.first()
    if row is None:
        raise DispatcherError("not_found", "task not found or worker_pid mismatch")
    return KanbanResponse(
        task_id=task_id,
        lifecycle_stage=str(row.lifecycle_stage),
        dispatch_status=(None if row.dispatch_status is None else str(row.dispatch_status)),
        action="heartbeat_ack",
    )


async def kill_task(
    session: AsyncSession,
    *,
    task_id: str,
    execution_id: str | None,
    reason: str,
) -> KanbanResponse:
    """worker を強制終了。dispatch_status='reclaimed' / execution='cancelled'。"""
    row = await _get_task_row(session, task_id)
    if row is None:
        raise DispatcherError("not_found", "task not found")
    await session.execute(
        text(
            "update public.tasks set dispatch_status = 'reclaimed', "
            "blocked_reason = :rs, lifecycle_stage = 'blocked', "
            "worker_pid = null, updated_at = now() "
            "where id = cast(:id as uuid)"
        ),
        {"rs": reason, "id": task_id},
    )
    if execution_id is not None:
        await session.execute(
            text(
                "update public.task_executions set completed_at = now(), "
                "status = 'cancelled', error_summary = :rs "
                "where id = cast(:eid as uuid) and task_id = cast(:tid as uuid)"
            ),
            {"rs": reason, "eid": execution_id, "tid": task_id},
        )
    await _audit(
        session,
        action="kanban.kill",
        target_id=task_id,
        after={"execution_id": execution_id, "reason": reason},
    )
    return KanbanResponse(
        task_id=task_id,
        lifecycle_stage="blocked",
        dispatch_status="reclaimed",
        execution_status="cancelled" if execution_id else None,
        action="killed",
    )
