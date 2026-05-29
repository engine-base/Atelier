"""Task CRUD + 受入条件取得 サービス層 (T-A-26)。

RLS が効く AsyncSession を受け取り tasks を操作する。可視性/権限は RLS (T-D-16)。
状態変更で audit_logs 記録。契約 ↔ DB の enum / 名前↔uuid 差異を吸収する。
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.tasks import (
    AcceptanceCriteriaResponse,
    TaskBulkLifecycleRequest,
    TaskBulkLifecycleResponse,
    TaskCreate,
    TaskDecisionRequest,
    TaskExecutionResponse,
    TaskPriority,
    TaskResponse,
    TaskUpdate,
)

# priority: 契約 [critical, high, medium, low] ↔ DB [urgent, high, medium, low]
_PRIORITY_TO_DB = {"critical": "urgent", "high": "high", "medium": "medium", "low": "low"}
_PRIORITY_TO_API: dict[str, TaskPriority] = {
    "urgent": "critical",
    "high": "high",
    "medium": "medium",
    "low": "low",
}
# type: 契約のみの 'migration' は DB の 'infrastructure' に寄せる。他は 1:1。
_TYPE_TO_DB = {
    "foundation": "foundation",
    "screen": "screen",
    "feature": "feature",
    "verification": "verification",
    "infrastructure": "infrastructure",
    "migration": "infrastructure",
}

_SELECT_COLS = (
    "t.id, t.project_id, t.category, t.title, t.description, t.type, t.estimated_hours, "
    "t.priority, t.lifecycle_stage, t.dispatch_status, t.summary, t.metadata, "
    "t.blocked_reason, t.retry_count, t.worktree_path, t.worker_pid, "
    "t.acceptance_criteria_id, t.created_at, t.updated_at, t.deleted_at, "
    "(select ph.name from public.phases ph where ph.id = t.phase_id) AS phase_name, "
    "(select e.name from public.ai_employees e where e.id = t.assigned_employee_id) AS assignee_name"
)


def _jsonb(value: object, default: object) -> Any:
    if value is None:
        return default
    if isinstance(value, str):
        return json.loads(value)
    return value


def _row_to_response(row: Any) -> TaskResponse:
    return TaskResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        phase=(None if row.phase_name is None else str(row.phase_name)),
        category=str(row.category),
        title=str(row.title),
        description=(None if row.description is None else str(row.description)),
        type=str(row.type),
        estimated_hours=int(row.estimated_hours),
        priority=_PRIORITY_TO_API.get(str(row.priority), "medium"),
        lifecycle_stage=row.lifecycle_stage,
        dispatch_status=(None if row.dispatch_status is None else str(row.dispatch_status)),
        assigned_employee_id=(None if row.assignee_name is None else str(row.assignee_name)),
        summary=(None if row.summary is None else str(row.summary)),
        metadata=_jsonb(row.metadata, {}),
        blocked_reason=(None if row.blocked_reason is None else str(row.blocked_reason)),
        retry_count=int(row.retry_count),
        worktree_path=(None if row.worktree_path is None else str(row.worktree_path)),
        worker_pid=(None if row.worker_pid is None else int(row.worker_pid)),
        acceptance_criteria_id=(
            None if row.acceptance_criteria_id is None else str(row.acceptance_criteria_id)
        ),
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_tasks(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    lifecycle_stage: str | None = None,
    limit: int = 50,
) -> list[TaskResponse]:
    limit = max(1, min(limit, 200))
    where = ["t.deleted_at is null"]
    params: dict[str, object] = {"lim": limit}
    if project_id is not None:
        where.append("t.project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if lifecycle_stage is not None:
        where.append("t.lifecycle_stage = cast(:ls as task_lifecycle_enum)")
        params["ls"] = lifecycle_stage
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.tasks t "
            f"where {' and '.join(where)} order by t.created_at limit :lim"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_task(session: AsyncSession, task_id: str) -> TaskResponse | None:
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.tasks t "
            "where t.id = cast(:id as uuid) and t.deleted_at is null"
        ),
        {"id": task_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_task(session: AsyncSession, *, actor_id: str, data: TaskCreate) -> TaskResponse:
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.tasks "
            "(id, project_id, category, title, description, type, estimated_hours, priority) "
            "values (cast(:id as uuid), cast(:pid as uuid), :cat, :title, :desc, "
            "        cast(:ttype as task_type_enum), :est, cast(:prio as task_priority_enum))"
        ),
        {
            "id": new_id,
            "pid": data.project_id,
            "cat": data.category,
            "title": data.title,
            "desc": data.description,
            "ttype": _TYPE_TO_DB[data.type],
            "est": data.estimated_hours,
            "prio": _PRIORITY_TO_DB[data.priority],
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="task.create",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"title": data.title, "type": data.type},
        )
    )
    created = await get_task(session, new_id)
    if created is None:  # pragma: no cover - 直前に作成済
        raise RuntimeError("created task not visible after insert")
    return created


async def update_task(
    session: AsyncSession, *, actor_id: str, task_id: str, data: TaskUpdate
) -> TaskResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": task_id}
    if data.title is not None:
        sets.append("title = :title")
        params["title"] = data.title
    if data.description is not None:
        sets.append("description = :desc")
        params["desc"] = data.description
    if data.type is not None:
        sets.append("type = cast(:ttype as task_type_enum)")
        params["ttype"] = _TYPE_TO_DB[data.type]
    if data.estimated_hours is not None:
        sets.append("estimated_hours = :est")
        params["est"] = data.estimated_hours
    if data.priority is not None:
        sets.append("priority = cast(:prio as task_priority_enum)")
        params["prio"] = _PRIORITY_TO_DB[data.priority]
    if data.lifecycle_stage is not None:
        sets.append("lifecycle_stage = cast(:ls as task_lifecycle_enum)")
        params["ls"] = data.lifecycle_stage
    if data.blocked_reason is not None:
        sets.append("blocked_reason = :br")
        params["br"] = data.blocked_reason
    if not sets:
        return await get_task(session, task_id)

    res = await session.execute(
        text(
            f"update public.tasks set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="task.update",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
            after={k: v for k, v in params.items() if k != "id"},
        )
    )
    return await get_task(session, task_id)


async def delete_task(session: AsyncSession, *, actor_id: str, task_id: str) -> bool:
    res = await session.execute(
        text(
            "update public.tasks set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": task_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="task.delete",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
        )
    )
    return True


async def get_acceptance_criteria(
    session: AsyncSession, task_id: str
) -> AcceptanceCriteriaResponse | None:
    """task の 3-tier 受入条件 (1:1) を取得。task が不可視なら RLS で 0 行 = None。"""
    res = await session.execute(
        text(
            "select ac.id, ac.task_id, ac.html_path, ac.items, ac.version, "
            "       ac.created_at, ac.updated_at "
            "from public.acceptance_criteria ac "
            "where ac.task_id = cast(:tid as uuid)"
        ),
        {"tid": task_id},
    )
    row = res.first()
    if row is None:
        return None
    return AcceptanceCriteriaResponse(
        id=str(row.id),
        task_id=str(row.task_id),
        html_path=str(row.html_path),
        items=_jsonb(row.items, []),
        version=int(row.version),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


_EXEC_COLS = (
    "id, task_id, started_at, completed_at, score, ac_pass_rate, test_pass_rate, "
    "verification_score, retry_count, status, claude_code_session_id, "
    "logs_storage_path, error_summary, created_at"
)


def _exec_to_response(row: Any) -> TaskExecutionResponse:
    def _f(v: object) -> float | None:
        return None if v is None else float(v)  # type: ignore[arg-type]

    return TaskExecutionResponse(
        id=str(row.id),
        task_id=str(row.task_id),
        started_at=row.started_at,
        completed_at=row.completed_at,
        score=_f(row.score),
        ac_pass_rate=_f(row.ac_pass_rate),
        test_pass_rate=_f(row.test_pass_rate),
        verification_score=_f(row.verification_score),
        retry_count=int(row.retry_count),
        status=str(row.status),
        claude_code_session_id=(
            None if row.claude_code_session_id is None else str(row.claude_code_session_id)
        ),
        logs_storage_path=(None if row.logs_storage_path is None else str(row.logs_storage_path)),
        error_summary=(None if row.error_summary is None else str(row.error_summary)),
        created_at=row.created_at,
    )


async def list_executions(session: AsyncSession, *, task_id: str) -> list[TaskExecutionResponse]:
    """task の実行履歴を新しい順に。可視性は RLS (task_executions_select_member)。"""
    res = await session.execute(
        text(
            f"select {_EXEC_COLS} from public.task_executions "
            "where task_id = cast(:tid as uuid) order by started_at desc, id"
        ),
        {"tid": task_id},
    )
    return [_exec_to_response(r) for r in res.all()]


async def get_execution(
    session: AsyncSession, *, task_id: str, execution_id: str
) -> TaskExecutionResponse | None:
    res = await session.execute(
        text(
            f"select {_EXEC_COLS} from public.task_executions "
            "where id = cast(:eid as uuid) and task_id = cast(:tid as uuid)"
        ),
        {"eid": execution_id, "tid": task_id},
    )
    row = res.first()
    return None if row is None else _exec_to_response(row)


# --------------------------------------------------------------------------- #
# T-A-25: タスク一括再生 + 承認/差戻/再試行
# --------------------------------------------------------------------------- #
async def bulk_lifecycle(
    session: AsyncSession, *, actor_id: str, data: TaskBulkLifecycleRequest
) -> TaskBulkLifecycleResponse:
    """task_ids の lifecycle_stage を target_stage へ一括遷移。

    RLS tasks_update_member が enforce するため、可視/編集権限が無い task は
    自動的に 0 行 update となり skipped_task_ids に分類される。状態変更分
    (updated) は audit_logs に各 task ごとに記録する。
    """
    res = await session.execute(
        text(
            "update public.tasks set lifecycle_stage = cast(:st as task_lifecycle_enum) "
            "where id = any(cast(:ids as uuid[])) and deleted_at is null returning id"
        ),
        {"st": data.target_stage, "ids": list(data.task_ids)},
    )
    updated_rows = [str(r.id) for r in res.all()]
    updated_set = set(updated_rows)
    skipped = [tid for tid in data.task_ids if tid not in updated_set]
    writer = AuditWriter(session)
    for tid in updated_rows:
        await writer.write(
            AuditEvent(
                action="task.bulk_lifecycle",
                target_type="task",
                actor_type="user",
                actor_id=actor_id,
                target_id=tid,
                after={"target_stage": data.target_stage, "note": data.note},
            )
        )
    return TaskBulkLifecycleResponse(
        requested=len(data.task_ids),
        updated=len(updated_rows),
        updated_task_ids=updated_rows,
        skipped_task_ids=skipped,
    )


async def approve_task(
    session: AsyncSession, *, actor_id: str, task_id: str, data: TaskDecisionRequest
) -> TaskResponse | None:
    """承認: awaiting → done。それ以外の lifecycle_stage では None (409 でルータ処理)。"""
    res = await session.execute(
        text(
            "update public.tasks set lifecycle_stage = 'done' "
            "where id = cast(:id as uuid) and deleted_at is null "
            "and lifecycle_stage = 'awaiting' returning id"
        ),
        {"id": task_id},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="task.approve",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
            after={"decision": "approve", "note": data.note},
        )
    )
    return await get_task(session, task_id)


async def reject_task(
    session: AsyncSession, *, actor_id: str, task_id: str, data: TaskDecisionRequest
) -> TaskResponse | None:
    """差戻: awaiting → blocked (blocked_reason に note を保持)。awaiting でなければ None。"""
    res = await session.execute(
        text(
            "update public.tasks "
            "set lifecycle_stage = 'blocked', "
            "    blocked_reason = coalesce(:note, blocked_reason) "
            "where id = cast(:id as uuid) and deleted_at is null "
            "and lifecycle_stage = 'awaiting' returning id"
        ),
        {"id": task_id, "note": data.note},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="task.reject",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
            after={"decision": "reject", "note": data.note},
        )
    )
    return await get_task(session, task_id)


async def retry_task(
    session: AsyncSession, *, actor_id: str, task_id: str, data: TaskDecisionRequest
) -> TaskResponse | None:
    """再試行: blocked → ready、retry_count += 1。

    DB CHECK (retry_count <= 3) で頭打ち。blocked 以外の lifecycle では None。
    """
    res = await session.execute(
        text(
            "update public.tasks "
            "set lifecycle_stage = 'ready', "
            "    retry_count = retry_count + 1, "
            "    blocked_reason = null "
            "where id = cast(:id as uuid) and deleted_at is null "
            "and lifecycle_stage = 'blocked' returning id"
        ),
        {"id": task_id},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="task.retry",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
            after={"note": data.note},
        )
    )
    return await get_task(session, task_id)
