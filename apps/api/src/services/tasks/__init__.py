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
    PlayTaskRequest,
    PlayTaskResponse,
    RelatedResourceResponse,
    SpecChangeResolveResponse,
    SpecChangeResponse,
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
# NOTE: 契約のみの 'migration' は DB の 'infrastructure' に寄せる。他は 1:1。
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
    "t.dependencies, t.prerequisites, t.blocks, "
    "t.acceptance_criteria_id, t.verifier_employee_id, t.files_changed, "
    "t.mock_id, "
    "(select m.screen_name from public.mocks m where m.id = t.mock_id) AS mock_screen_name, "
    "t.created_at, t.updated_at, t.deleted_at, "
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
        dependencies=[str(x) for x in list(row.dependencies or [])],  # pyright: ignore[reportUnknownArgumentType, reportUnknownVariableType]
        prerequisites=[str(x) for x in list(row.prerequisites or [])],  # pyright: ignore[reportUnknownArgumentType, reportUnknownVariableType]
        blocks=[str(x) for x in list(row.blocks or [])],  # pyright: ignore[reportUnknownArgumentType, reportUnknownVariableType]
        worktree_path=(None if row.worktree_path is None else str(row.worktree_path)),
        worker_pid=(None if row.worker_pid is None else int(row.worker_pid)),
        acceptance_criteria_id=(
            None if row.acceptance_criteria_id is None else str(row.acceptance_criteria_id)
        ),
        verifier_employee_id=(
            None if row.verifier_employee_id is None else str(row.verifier_employee_id)
        ),
        files_changed=[str(x) for x in list(row.files_changed or [])],  # pyright: ignore[reportUnknownArgumentType, reportUnknownVariableType]
        mock_id=(None if row.mock_id is None else str(row.mock_id)),
        mock_screen_name=(
            None if row.mock_screen_name is None else str(row.mock_screen_name)
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


def _placeholder_mock_html(screen_name: str) -> str:
    """GAP-140: タスク分解時に用意する「まっさらのデザイン」プレースホルダー。

    タイトルだけを持つ空のキャンバス — ここに作り込む (チャットの成果物は
    同じ画面名で自動的に v2, v3… と連鎖し、S-H01 の履歴に乗る)。"""
    import html as html_mod

    safe = html_mod.escape(screen_name)
    return (
        "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\">"
        f"<title>{safe}</title>"
        "<style>body{margin:0;font-family:sans-serif;background:#f8fafc;color:#0f172a;"
        "display:grid;place-items:center;min-height:100vh}"
        ".ph{border:2px dashed #cbd5e1;border-radius:16px;padding:48px 64px;text-align:center}"
        ".ph h1{font-size:22px;margin:0 0 8px}.ph p{color:#64748b;font-size:13px;margin:0}"
        "</style></head><body>"
        f'<div class="ph" data-placeholder="1"><h1>{safe}</h1>'
        "<p>タスク分解で用意されたプレースホルダーです。<br>"
        "チャットの PC 操作や「編集」(ワンダへの依頼) でここに作り込んでください。</p>"
        "</div></body></html>"
    )


async def ensure_screen_mock(
    session: AsyncSession, *, actor_id: str, project_id: str, screen_name: str
) -> str:
    """GAP-140: 画面名に対応するモックを保証して mock_id を返す。

    既に同 project + 画面名のチェーンがあれば最新版に紐づけ、無ければ
    プレースホルダー v1 (mockdb 保存) を作成する。"""
    from src.services.mocks.artifacts import MOCKDB_PREFIX, store_content_service

    latest = (
        await session.execute(
            text(
                "select id from public.mocks "
                "where project_id = cast(:pid as uuid) and screen_name = :sn "
                "and deleted_at is null order by version desc limit 1"
            ),
            {"pid": project_id, "sn": screen_name},
        )
    ).first()
    if latest is not None:
        return str(latest.id)

    content_id = await store_content_service(_placeholder_mock_html(screen_name))
    mock_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.mocks "
            "(id, project_id, screen_name, html_storage_path, version, meta_tags) "
            "values (cast(:id as uuid), cast(:pid as uuid), :sn, :path, 1, "
            "        cast(:meta as jsonb))"
        ),
        {
            "id": mock_id,
            "pid": project_id,
            "sn": screen_name,
            "path": f"{MOCKDB_PREFIX}{content_id}",
            "meta": json.dumps({"author": "system", "source": "task_placeholder"}),
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="mock.create_placeholder",
            target_type="mock",
            actor_type="user",
            actor_id=actor_id,
            target_id=mock_id,
            after={"screen_name": screen_name, "source": "task_placeholder"},
        )
    )
    return mock_id


async def create_task(session: AsyncSession, *, actor_id: str, data: TaskCreate) -> TaskResponse:
    new_id = str(uuid.uuid4())
    # GAP-140: 画面タスクは分解時に画面モック (プレースホルダー) を保証して紐づける
    mock_id: str | None = None
    if data.screen_name is not None and data.screen_name.strip() != "":
        mock_id = await ensure_screen_mock(
            session,
            actor_id=actor_id,
            project_id=data.project_id,
            screen_name=data.screen_name.strip(),
        )
    await session.execute(
        text(
            "insert into public.tasks "
            "(id, project_id, category, title, description, type, estimated_hours, priority, "
            " mock_id) "
            "values (cast(:id as uuid), cast(:pid as uuid), :cat, :title, :desc, "
            "        cast(:ttype as task_type_enum), :est, cast(:prio as task_priority_enum), "
            "        cast(:mock as uuid))"
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
            "mock": mock_id,
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
    if data.verifier_employee_id is not None:
        # GAP-025: 検証担当。"" は解除。他 WS 社員は FK/サブクエリで拒否 (422)
        if data.verifier_employee_id == "":
            sets.append("verifier_employee_id = null")
        else:
            ok = await session.execute(
                text(
                    "select exists("
                    " select 1 from public.ai_employees e "
                    " join public.projects p on p.workspace_id = e.workspace_id "
                    " join public.tasks t on t.project_id = p.id "
                    " where e.id = cast(:vid as uuid) and t.id = cast(:id as uuid))"
                ),
                {"vid": data.verifier_employee_id, "id": task_id},
            )
            if not bool(ok.scalar_one()):
                raise ValueError("verifier must belong to the task's workspace")
            sets.append("verifier_employee_id = cast(:vid as uuid)")
            params["vid"] = data.verifier_employee_id
    if data.screen_name is not None and data.screen_name.strip() != "":
        # GAP-140: 後付けの画面紐づけ — 既存チェーン最新 or プレースホルダー作成
        current = await get_task(session, task_id)
        if current is None:
            return None
        params["mock"] = await ensure_screen_mock(
            session,
            actor_id=actor_id,
            project_id=current.project_id,
            screen_name=data.screen_name.strip(),
        )
        sets.append("mock_id = cast(:mock as uuid)")
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
    "id, task_id, started_at, completed_at, "
    "extract(epoch from (coalesce(completed_at, now()) - started_at)) as duration_seconds, "
    "score, ac_pass_rate, test_pass_rate, "
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
        duration_seconds=_f(row.duration_seconds),
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
    # 対応する承認インボックス通知 (kanban.complete が作成) を解決済みにする。
    await session.execute(
        text(
            "update public.approval_inbox set status = 'approved', resolved_at = now() "
            "where target_type = 'task' and target_id = cast(:id as uuid) "
            "and type = 'task_approval' and status = 'pending'"
        ),
        {"id": task_id},
    )
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
    # 対応する承認インボックス通知を却下として解決する。
    await session.execute(
        text(
            "update public.approval_inbox set status = 'rejected', resolved_at = now(), "
            "resolution_note = :note "
            "where target_type = 'task' and target_id = cast(:id as uuid) "
            "and type = 'task_approval' and status = 'pending'"
        ),
        {"id": task_id, "note": data.note},
    )
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


# --------------------------------------------------------------------------- #
# T-A-24: タスク再生 (dispatcher 連動)
# --------------------------------------------------------------------------- #

# 同時に走れる task_executions の上限。並列上限超過時は queue_position を返す。
_PARALLEL_LIMIT = 5


class PlayResult:
    """play_task の結果を表す軽量タプル相当。

    success: 成功 (202 相当)
    not_found: タスク不可視 (404)
    invalid_state: lifecycle_stage が ready / blocked 以外 (409)
    deps_unmet: 依存先 task の lifecycle が done でない (409)
    """

    SUCCESS = "success"
    NOT_FOUND = "not_found"
    INVALID_STATE = "invalid_state"
    DEPS_UNMET = "deps_unmet"


async def _running_execution_count(session: AsyncSession) -> int:
    res = await session.execute(
        text("select count(*) from public.task_executions where status = 'running'")
    )
    return int(res.scalar_one())


async def _all_deps_done(session: AsyncSession, *, task_id: str) -> bool:
    """task.dependencies に列挙された全 task が lifecycle_stage='done' か。"""
    res = await session.execute(
        text("select t.dependencies from public.tasks t where t.id = cast(:tid as uuid)"),
        {"tid": task_id},
    )
    row = res.first()
    if row is None or not row.dependencies:
        return True
    deps = list(row.dependencies)
    if not deps:
        return True
    res2 = await session.execute(
        text(
            "select count(*) from public.tasks "
            "where id = any(cast(:ids as uuid[])) and lifecycle_stage = 'done' "
            "and deleted_at is null"
        ),
        {"ids": [str(d) for d in deps]},
    )
    done_cnt = int(res2.scalar_one())
    return done_cnt >= len(deps)


async def play_task(
    session: AsyncSession,
    *,
    actor_id: str,
    task_id: str,
    data: PlayTaskRequest,
) -> tuple[str, PlayTaskResponse | None]:
    """task を dispatcher に投入する。

    1. visibility 確認 (RLS): 不可視なら NOT_FOUND
    2. lifecycle_stage が ready / blocked のみ受理 (それ以外は INVALID_STATE)
    3. force=False かつ依存未完なら DEPS_UNMET
    4. 並列上限超過なら queue_position を返す
    5. task を in_progress + dispatch_status=queued に遷移し、task_executions に
       running 行を作成して PlayTaskResponse を返す (queued→spawning は Bridge の
       kanban.pick が行う — e2e 通しで検出した契約不一致の是正)
    6. 全分岐で audit_logs に記録 (state-changing audit)
    """
    cur = await session.execute(
        text(
            "select id, lifecycle_stage, retry_count, worktree_path "
            "from public.tasks where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": task_id},
    )
    row = cur.first()
    if row is None:
        return PlayResult.NOT_FOUND, None
    stage = str(row.lifecycle_stage)
    if stage not in ("ready", "blocked"):
        return PlayResult.INVALID_STATE, None
    if not data.force and not await _all_deps_done(session, task_id=task_id):
        return PlayResult.DEPS_UNMET, None

    running = await _running_execution_count(session)
    queue_position = max(0, running + 1 - _PARALLEL_LIMIT)

    # task は常に queued で投入する。spawning への遷移は Bridge の kanban.pick の
    # 責務 (pick は dispatch_status='queued' しか claim しないため、ここで spawning に
    # すると誰にも拾われず永遠に実行されない — e2e 通しで検出したパイプ断絶)。
    new_dispatch = "queued"
    await session.execute(
        text(
            "update public.tasks "
            "set lifecycle_stage = 'in_progress', "
            "dispatch_status = cast(:ds as task_dispatch_enum), "
            "updated_at = now() "
            "where id = cast(:id as uuid)"
        ),
        {"id": task_id, "ds": new_dispatch},
    )

    exec_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.task_executions "
            "(id, task_id, started_at, retry_count, status) "
            "values (cast(:eid as uuid), cast(:tid as uuid), now(), :rc, 'running')"
        ),
        {"eid": exec_id, "tid": task_id, "rc": int(row.retry_count)},
    )

    await AuditWriter(session).write(
        AuditEvent(
            action="task.play",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
            after={
                "execution_id": exec_id,
                "lifecycle_stage": "in_progress",
                "dispatch_status": new_dispatch,
                "queue_position": queue_position if queue_position > 0 else None,
                "force": data.force,
            },
        )
    )

    return PlayResult.SUCCESS, PlayTaskResponse(
        task_id=task_id,
        lifecycle_stage="in_progress",
        dispatch_status=new_dispatch,
        execution_id=exec_id,
        worktree_path=(None if row.worktree_path is None else str(row.worktree_path)),
        bridge_command=f"atelier-bridge spawn --task={task_id} --exec={exec_id}",
        queue_position=queue_position if queue_position > 0 else None,
    )


# --------------------------------------------------------------------------- #
# GAP-025: S-I02 タスク詳細 (仕様変更検知 / 関連資料)
# --------------------------------------------------------------------------- #


async def get_spec_change(session: AsyncSession, *, task_id: str) -> SpecChangeResponse | None:
    """仕様変更の実検知 (GAP-025①)。

    検知源: タスクに紐づくモック (mock_id) と同一 project+screen_name の
    より新しいバージョンが後からアップロードされている状態。解決済み
    (task.metadata.spec_change_resolutions に latest_mock_id が記録済み) は
    再表示しない。mock_id 未設定 / 新版なしは None (カード非描画)。
    """
    res = await session.execute(
        text(
            "select t.metadata, m.id as mock_id, m.screen_name, m.version, m.project_id "
            "from public.tasks t join public.mocks m on m.id = t.mock_id "
            "where t.id = cast(:id as uuid) and t.deleted_at is null "
            "and m.deleted_at is null"
        ),
        {"id": task_id},
    )
    row = res.first()
    if row is None:
        return None
    latest = await session.execute(
        text(
            "select id, version, created_at from public.mocks "
            "where project_id = cast(:pid as uuid) and screen_name = :sn "
            "and deleted_at is null and version > :ver "
            "order by version desc limit 1"
        ),
        {"pid": str(row.project_id), "sn": str(row.screen_name), "ver": int(row.version)},
    )
    latest_row = latest.first()
    if latest_row is None:
        return None
    meta = _jsonb(row.metadata, {})
    resolutions = meta.get("spec_change_resolutions")
    if isinstance(resolutions, dict) and str(latest_row.id) in resolutions:
        return None
    return SpecChangeResponse(
        kind="mock_updated",
        mock_id=str(row.mock_id),
        screen_name=str(row.screen_name),
        current_version=int(row.version),
        latest_version=int(latest_row.version),
        latest_mock_id=str(latest_row.id),
        detected_at=latest_row.created_at,
    )


async def resolve_spec_change(
    session: AsyncSession,
    *,
    actor_id: str,
    task_id: str,
    choice: str,
    latest_mock_id: str,
) -> SpecChangeResolveResponse | None:
    """仕様変更 3 択の実行 (GAP-025①)。返り値 None = タスク不可視/不在。

    adopt:   mock_id を最新へ差替 (最新仕様で実装し直す)
    split:   現状のまま、追加対応をフォロータスクとして実起票
    discard: blocked + dispatch 解除 (分解からやり直す前提を状態で明示)
    いずれも metadata.spec_change_resolutions[latest_mock_id] に記録して再表示を止める。
    """
    task = await get_task(session, task_id)
    if task is None:
        return None
    follow_up_id: str | None = None
    if choice == "adopt":
        await session.execute(
            text(
                "update public.tasks set mock_id = cast(:mid as uuid), updated_at = now() "
                "where id = cast(:id as uuid)"
            ),
            {"mid": latest_mock_id, "id": task_id},
        )
        note = "最新仕様 (新しいモック) をこのタスクに取り込みました"
    elif choice == "split":
        follow_up = await create_task(
            session,
            actor_id=actor_id,
            data=TaskCreate(
                project_id=task.project_id,
                category="仕様変更フォロー",
                title=f"仕様変更対応: {task.title}"[:200],
                type="feature",
                estimated_hours=1,
                description=(
                    "S-I02 の仕様変更 3 択「現状の実装で完了にする」から起票。"
                    "見積は未実施のため暫定 1h — triage レビューで見直すこと。"
                ),
            ),
        )
        follow_up_id = follow_up.id
        note = f"追加対応を別タスク「{follow_up.title}」として起票しました"
    else:  # discard
        await session.execute(
            text(
                "update public.tasks set lifecycle_stage = 'blocked', "
                "blocked_reason = '仕様変更により再分解待ち', "
                "dispatch_status = null, dispatch_promoted_at = null, "
                "worker_pid = null, updated_at = now() "
                "where id = cast(:id as uuid)"
            ),
            {"id": task_id},
        )
        note = "作業を破棄し、再分解待ち (blocked) にしました"
    await session.execute(
        text(
            "update public.tasks set metadata = jsonb_set("
            "coalesce(metadata, cast('{}' as jsonb)), "
            "array['spec_change_resolutions', cast(:mid as text)], "
            "to_jsonb(cast(:choice as text)), true), "
            "updated_at = now() where id = cast(:id as uuid)"
        ),
        {"mid": latest_mock_id, "choice": choice, "id": task_id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action=f"task.spec_change.{choice}",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
            after={"latest_mock_id": latest_mock_id, "follow_up_task_id": follow_up_id},
        )
    )
    return SpecChangeResolveResponse(choice=choice, note=note, follow_up_task_id=follow_up_id)


async def list_related_resources(
    session: AsyncSession, *, task_id: str
) -> list[RelatedResourceResponse] | None:
    """関連資料の逆引き (GAP-025③)。実リンクのみ — 存在しない資料は返さない。

    返り値 None = タスク不可視/不在。
    """
    res = await session.execute(
        text(
            "select t.mock_id, t.spec_html_path, t.acceptance_criteria_id, "
            "t.worktree_path, t.files_changed, t.title "
            "from public.tasks t where t.id = cast(:id as uuid) and t.deleted_at is null"
        ),
        {"id": task_id},
    )
    row = res.first()
    if row is None:
        return None
    items: list[RelatedResourceResponse] = []
    if row.mock_id is not None:
        mock = await session.execute(
            text(
                "select id, screen_name, version, updated_at from public.mocks "
                "where id = cast(:mid as uuid) and deleted_at is null"
            ),
            {"mid": str(row.mock_id)},
        )
        m = mock.first()
        if m is not None:
            items.append(
                RelatedResourceResponse(
                    kind="mock",
                    name=f"設計モック {m.screen_name}",
                    meta=f"バージョン {int(m.version)}",
                    href=f"/mocks?mock={m.id}",
                )
            )
    if row.spec_html_path is not None:
        items.append(
            RelatedResourceResponse(
                kind="spec",
                name="仕様書",
                meta=str(row.spec_html_path),
                href=None,
            )
        )
    if row.acceptance_criteria_id is not None:
        ac = await session.execute(
            text(
                "select jsonb_array_length(coalesce(items, '[]'::jsonb)) as total, version "
                "from public.acceptance_criteria where id = cast(:aid as uuid)"
            ),
            {"aid": str(row.acceptance_criteria_id)},
        )
        a = ac.first()
        if a is not None:
            items.append(
                RelatedResourceResponse(
                    kind="acceptance_criteria",
                    name=f"受入条件（{int(a.total)} 項目）",
                    meta=f"バージョン {int(a.version)}",
                    href=None,
                )
            )
    files = [str(x) for x in list(row.files_changed or [])]  # pyright: ignore[reportUnknownArgumentType, reportUnknownVariableType]
    if row.worktree_path is not None or files:
        items.append(
            RelatedResourceResponse(
                kind="branch",
                name=(
                    f"作業ブランチ {row.worktree_path}"
                    if row.worktree_path is not None
                    else "ソースコード変更"
                ),
                meta=f"変更 {len(files)} ファイル",
                href=None,
            )
        )
    knowledge = await session.execute(
        text(
            "select k.id, k.title, r.reference_count from public.knowledge_references r "
            "join public.knowledge_nodes k on k.id = r.knowledge_id "
            "where r.referrer_type = 'task' and r.referrer_id = cast(:id as uuid) "
            "and k.deleted_at is null order by r.last_referenced_at desc limit 10"
        ),
        {"id": task_id},
    )
    for k in knowledge.all():
        items.append(
            RelatedResourceResponse(
                kind="knowledge",
                name=str(k.title),
                meta=f"参照 {int(k.reference_count)} 回",
                href=f"/knowledge?node={k.id}",
            )
        )
    return items
