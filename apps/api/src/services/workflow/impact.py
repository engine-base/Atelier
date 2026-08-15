# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""F-IMP01 影響範囲解析 + phase 別タスク集計 + 依存整合性チェック (GAP-022)。

- analyze: タスクを別フェーズへ移動した場合の影響を tasks.dependencies (uuid[])
  の推移的走査 (recursive CTE) で実計算する。推測イベントは生成しない。
  実行は impact_analyses に記録 (統計「F-IMP01 実行回数（本日）」の実データ源)。
- apply: 実移動 (tasks.phase_id) + 影響先のうち完了済タスクをリファクタタスク
  として自動起票 (F-CUC02, origin_type='refactor'、見積未実施 1h を明示)。
- task_stats: phase 別の total/done/awaiting + 完了実行スコア平均 (実 task_executions)。
- consistency: dependencies が実在タスクを指しているかの実計算 (OK / 不整合 N 件)。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.workflow import (
    ConsistencyCheckResponse,
    ImpactAffectedTask,
    ImpactAnalysisResponse,
    ImpactApplyResponse,
    PhaseTaskStatsResponse,
)

from . import is_uuid


async def _load_analysis(session: AsyncSession, analysis_id: str) -> Any | None:
    if not is_uuid(analysis_id):
        return None
    res = await session.execute(
        text(
            "select a.id, a.project_id, a.task_id, a.target_phase_id, "
            "a.affected_task_ids, a.affected_done_task_ids, a.applied, "
            "a.refactor_task_ids, t.title as task_title, p.name as target_phase_name "
            "from public.impact_analyses a "
            "join public.tasks t on t.id = a.task_id "
            "join public.phases p on p.id = a.target_phase_id "
            "where a.id = cast(:id as uuid)"
        ),
        {"id": analysis_id},
    )
    return res.first()


async def _affected_tasks(
    session: AsyncSession, task_id: str, project_id: str
) -> list[ImpactAffectedTask]:
    """task_id に (推移的に) 依存するタスク群 — tasks.dependencies の実走査。"""
    res = await session.execute(
        text(
            "with recursive dep as ( "
            "  select t.id from public.tasks t "
            "  where cast(:tid as uuid) = any(t.dependencies) "
            "    and t.project_id = cast(:pid as uuid) and t.deleted_at is null "
            "  union "
            "  select t.id from public.tasks t join dep d on d.id = any(t.dependencies) "
            "  where t.project_id = cast(:pid as uuid) and t.deleted_at is null "
            ") "
            "select t.id, t.title, t.lifecycle_stage from public.tasks t "
            "join dep on dep.id = t.id order by t.created_at"
        ),
        {"tid": task_id, "pid": project_id},
    )
    return [
        ImpactAffectedTask(id=str(r.id), title=str(r.title), lifecycle_stage=str(r.lifecycle_stage))
        for r in res.all()
    ]


async def analyze(
    session: AsyncSession, *, actor_id: str, task_id: str, target_phase_id: str
) -> ImpactAnalysisResponse | None:
    """影響範囲を解析し impact_analyses に記録する。

    None = task/phase 不可視・不在。ValueError = phase が別プロジェクト (422)。
    """
    if not is_uuid(task_id) or not is_uuid(target_phase_id):
        return None
    t = await session.execute(
        text(
            "select id, title, project_id from public.tasks "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": task_id},
    )
    task = t.first()
    if task is None:
        return None
    p = await session.execute(
        text("select id, name, project_id from public.phases where id = cast(:id as uuid)"),
        {"id": target_phase_id},
    )
    phase = p.first()
    if phase is None:
        return None
    if str(phase.project_id) != str(task.project_id):
        raise ValueError("target phase belongs to a different project")

    affected = await _affected_tasks(session, task_id, str(task.project_id))
    done_ids = [a.id for a in affected if a.lifecycle_stage == "done"]

    row = await session.execute(
        text(
            "insert into public.impact_analyses "
            "(project_id, task_id, target_phase_id, affected_task_ids, affected_done_task_ids) "
            "values (cast(:pid as uuid), cast(:tid as uuid), cast(:phid as uuid), "
            "cast(:aff as uuid[]), cast(:done as uuid[])) "
            "returning id, applied, refactor_task_ids, affected_done_task_ids"
        ),
        {
            "pid": str(task.project_id),
            "tid": task_id,
            "phid": target_phase_id,
            "aff": [a.id for a in affected],
            "done": done_ids,
        },
    )
    created = row.one()
    await AuditWriter(session).write(
        AuditEvent(
            action="task.impact.analyze",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=task_id,
            after={
                "analysis_id": str(created.id),
                "target_phase_id": target_phase_id,
                "affected": len(affected),
                "done": len(done_ids),
            },
        )
    )
    return ImpactAnalysisResponse(
        id=str(created.id),
        task_id=str(task.id),
        task_title=str(task.title),
        target_phase_id=str(phase.id),
        target_phase_name=str(phase.name),
        affected=affected,
        done_count=len(done_ids),
        applied=False,
    )


async def apply(
    session: AsyncSession, *, actor_id: str, analysis_id: str
) -> ImpactApplyResponse | None:
    """解析結果を承認して適用する。

    実移動 + 完了済影響タスクのリファクタ自動起票 (F-CUC02)。
    None = 不可視/不在。ValueError = 適用済み (409)。
    """
    row = await _load_analysis(session, analysis_id)
    if row is None:
        return None
    if bool(row.applied):
        raise ValueError("analysis already applied")

    await session.execute(
        text(
            "update public.tasks set phase_id = cast(:phid as uuid), updated_at = now() "
            "where id = cast(:tid as uuid)"
        ),
        {"phid": str(row.target_phase_id), "tid": str(row.task_id)},
    )

    # 完了済の影響タスク → リファクタタスク自動起票 (見積未実施 1h を明示)
    refactor_ids: list[str] = []
    for done_id in [str(x) for x in list(row.affected_done_task_ids or [])]:
        created = await session.execute(
            text(
                "insert into public.tasks "
                "(project_id, phase_id, category, title, description, type, "
                " estimated_hours, priority, lifecycle_stage, origin_type, metadata) "
                "select t.project_id, cast(:phid as uuid), 'リファクタ', "
                "'リファクタ: ' || t.title, "
                "'F-IMP01 影響範囲解析により自動起票 (F-CUC02)。移動タスク「' || :moved || "
                "'」の影響を受ける完了済タスクの追随修正。見積は未実施 (暫定 1h)。', "
                "t.type, 1, 'high', 'triage', 'refactor', "
                "jsonb_build_object('impact_analysis_id', cast(:aid as text), "
                "'source_task_id', cast(:src as text), 'moved_task_id', cast(:tid as text)) "
                "from public.tasks t where t.id = cast(:src as uuid) "
                "returning id"
            ),
            {
                "phid": str(row.target_phase_id),
                "moved": str(row.task_title),
                "aid": analysis_id,
                "src": done_id,
                "tid": str(row.task_id),
            },
        )
        created_row = created.first()
        if created_row is not None:
            refactor_ids.append(str(created_row.id))

    await session.execute(
        text(
            "update public.impact_analyses "
            "set applied = true, refactor_task_ids = cast(:rids as uuid[]), applied_at = now() "
            "where id = cast(:id as uuid)"
        ),
        {"rids": refactor_ids, "id": analysis_id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="task.impact.apply",
            target_type="task",
            actor_type="user",
            actor_id=actor_id,
            target_id=str(row.task_id),
            after={
                "analysis_id": analysis_id,
                "moved_to_phase_id": str(row.target_phase_id),
                "refactor_task_ids": refactor_ids,
            },
        )
    )
    return ImpactApplyResponse(
        task_id=str(row.task_id),
        moved_to_phase_id=str(row.target_phase_id),
        refactor_task_ids=refactor_ids,
    )


async def today_count(session: AsyncSession, project_id: str) -> int:
    """統計「F-IMP01 実行回数（本日）」 — impact_analyses の実カウント。"""
    if not is_uuid(project_id):
        return 0
    res = await session.execute(
        text(
            "select count(*) from public.impact_analyses "
            "where project_id = cast(:pid as uuid) and created_at::date = current_date"
        ),
        {"pid": project_id},
    )
    return int(res.scalar_one())


async def task_stats(session: AsyncSession, project_id: str) -> list[PhaseTaskStatsResponse]:
    """phase 別タスク集計 (total/done/awaiting + 完了実行スコア平均)。"""
    if not is_uuid(project_id):
        return []
    res = await session.execute(
        text(
            "select t.phase_id, "
            "count(*) as total, "
            "count(*) filter (where t.lifecycle_stage = 'done') as done, "
            "count(*) filter (where t.lifecycle_stage = 'awaiting') as awaiting, "
            "avg(s.score) as avg_score "
            "from public.tasks t "
            "left join lateral ( "
            "  select te.score from public.task_executions te "
            "  where te.task_id = t.id and te.score is not null "
            "  order by te.started_at desc limit 1 "
            ") s on true "
            "where t.project_id = cast(:pid as uuid) and t.deleted_at is null "
            "and t.phase_id is not null "
            "group by t.phase_id"
        ),
        {"pid": project_id},
    )
    return [
        PhaseTaskStatsResponse(
            phase_id=str(r.phase_id),
            total=int(r.total),
            done=int(r.done),
            awaiting=int(r.awaiting),
            avg_score=(None if r.avg_score is None else round(float(r.avg_score), 2)),
        )
        for r in res.all()
    ]


async def consistency(session: AsyncSession, project_id: str) -> ConsistencyCheckResponse:
    """依存整合性チェック — dependencies の参照先が実在するかの実計算。"""
    if not is_uuid(project_id):
        return ConsistencyCheckResponse(ok=True, dangling_count=0)
    res = await session.execute(
        text(
            "select count(*) from ( "
            "  select t.id, dep from public.tasks t, unnest(t.dependencies) dep "
            "  where t.project_id = cast(:pid as uuid) and t.deleted_at is null "
            "  and not exists ( "
            "    select 1 from public.tasks x where x.id = dep and x.deleted_at is null "
            "  ) "
            ") q"
        ),
        {"pid": project_id},
    )
    dangling = int(res.scalar_one())
    return ConsistencyCheckResponse(ok=dangling == 0, dangling_count=dangling)
