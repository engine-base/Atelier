"""Project CRUD サービス層 (T-A-10)。

RLS が効く AsyncSession (get_rls_session) を受け取り projects を操作する。
可視性/権限は RLS policy (T-D-15) で enforce、状態変更で audit_logs 記録。

契約 ↔ DB の enum / 列名差異を本層で吸収する:
  type   : self_product↔internal_product / client_project↔client_work / personal
  status : in_progress↔active / draft / paused / archived
  ai_learning_opt_out (契約) ↔ ai_training_optout (DB 列)
  description は DB 列が無いため settings JSONB に格納
"""

from __future__ import annotations

import base64
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.projects import (
    AccountAiLearning,
    ActivityItem,
    PaginationMeta,
    ProjectCreate,
    ProjectDashboard,
    ProjectResponse,
    ProjectStatus,
    ProjectType,
    ProjectUpdate,
)

_TYPE_TO_DB: dict[str, str] = {
    "self_product": "internal_product",
    "client_project": "client_work",
    "personal": "personal",
}
_TYPE_TO_API: dict[str, ProjectType] = {
    "internal_product": "self_product",
    "client_work": "client_project",
    "personal": "personal",
}
_STATUS_TO_DB: dict[str, str] = {
    "in_progress": "active",
    "draft": "draft",
    "paused": "paused",
    "archived": "archived",
}
_STATUS_TO_API: dict[str, ProjectStatus] = {
    "active": "in_progress",
    "draft": "draft",
    "paused": "paused",
    "archived": "archived",
}

_VALID_PHASES = {
    "hearing",
    "requirements",
    "architecture",
    "design",
    "breakdown",
    "tasks",
    "implementation",
    "verification",
    "delivery",
}

_SELECT_COLS = (
    "p.id, p.workspace_id, p.name, p.client_name, p.project_type, p.status, p.ai_training_optout, "
    "p.settings ->> 'description' AS description, "
    "p.created_at, p.updated_at, p.deleted_at, "
    "coalesce("
    "  (select ph.name from public.phases ph where ph.project_id = p.id "
    "     and ph.status = 'in_progress' order by ph.\"order\" limit 1), "
    "  'hearing') AS current_phase"
)


# phases.name は日本語 (seed の canonical 9) で入るが、API 契約の current_phase は
# 英語キー。従来この変換が無く、実工程が進んでも常に 'hearing' へフォールバックして
# 一覧/詳細のフェーズ表示が古いままになるバグがあった (design-audit R3 で検出)。
_PHASE_NAME_TO_KEY = {
    "ヒアリング": "hearing",
    "要件定義": "requirements",
    "アーキ設計": "architecture",
    "デザイン": "design",
    "機能分解": "breakdown",
    "タスク分解": "tasks",
    "実装": "implementation",
    "検証": "verification",
    "納品": "delivery",
}


def _row_to_response(row: Any) -> ProjectResponse:
    raw_phase = str(row.current_phase)
    phase = _PHASE_NAME_TO_KEY.get(raw_phase, raw_phase)
    return ProjectResponse(
        id=str(row.id),
        workspace_id=str(row.workspace_id),
        name=str(row.name),
        client_name=(None if row.client_name is None else str(row.client_name)),
        description=(None if row.description is None else str(row.description)),
        type=_TYPE_TO_API.get(str(row.project_type), "personal"),
        status=_STATUS_TO_API.get(str(row.status), "draft"),
        ai_learning_opt_out=bool(row.ai_training_optout),
        current_phase=phase if phase in _VALID_PHASES else "hearing",
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _encode_cursor(created_at: object, pid: str) -> str:
    raw = f"{created_at}|{pid}".encode()
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode_cursor(cursor: str) -> tuple[str, str]:
    raw = base64.urlsafe_b64decode(cursor.encode()).decode()
    ts, pid = raw.split("|", 1)
    return ts, pid


async def list_projects(
    session: AsyncSession,
    *,
    workspace_id: str | None = None,
    status: str | None = None,
    cursor: str | None = None,
    limit: int = 20,
    include_deleted: bool = False,
) -> tuple[list[ProjectResponse], PaginationMeta]:
    """RLS 可視な project 一覧 (keyset cursor: created_at, id 昇順)。

    include_deleted=True で論理削除済 (ゴミ箱) も含める (T-A-12 / 30 日猶予内の復元向け)。
    """
    limit = max(1, min(limit, 100))
    params: dict[str, object] = {"lim": limit + 1}
    where = ["1=1"] if include_deleted else ["p.deleted_at is null"]
    if workspace_id is not None:
        where.append("p.workspace_id = cast(:wid as uuid)")
        params["wid"] = workspace_id
    if status is not None and status in _STATUS_TO_DB:
        where.append("p.status = :st")
        params["st"] = _STATUS_TO_DB[status]
    if cursor is not None:
        ts, pid = _decode_cursor(cursor)
        where.append("(p.created_at, p.id) > (cast(:cts as timestamptz), cast(:cid as uuid))")
        params["cts"] = ts
        params["cid"] = pid

    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.projects p "
            f"where {' and '.join(where)} order by p.created_at, p.id limit :lim"
        ),
        params,
    )
    rows = res.all()
    has_more = len(rows) > limit
    page = rows[:limit]
    items = [_row_to_response(r) for r in page]
    next_cursor = _encode_cursor(page[-1].created_at, page[-1].id) if has_more and page else None

    count_where = ["1=1"] if include_deleted else ["p.deleted_at is null"]
    count_params: dict[str, object] = {}
    if workspace_id is not None:
        count_where.append("p.workspace_id = cast(:wid as uuid)")
        count_params["wid"] = workspace_id
    total = await session.execute(
        text(f"select count(*) from public.projects p where {' and '.join(count_where)}"),
        count_params,
    )
    meta = PaginationMeta(
        next_cursor=next_cursor, limit=limit, total_estimate=int(total.scalar_one())
    )
    return items, meta


async def get_project(session: AsyncSession, project_id: str) -> ProjectResponse | None:
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.projects p "
            "where p.id = cast(:id as uuid) and p.deleted_at is null"
        ),
        {"id": project_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_project(
    session: AsyncSession, *, actor_id: str, data: ProjectCreate
) -> ProjectResponse:
    # workspace member は作成時点で既に可視なので RETURNING でも問題ないが、
    # workspaces (T-A-06) と同じく client 生成 id + RETURNING 無しで統一する。
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.projects (id, workspace_id, name, project_type, settings) "
            "values (cast(:id as uuid), cast(:wid as uuid), :name, "
            "        cast(:ptype as project_type_enum), "
            "        jsonb_build_object('description', cast(:desc as text)))"
        ),
        {
            "id": new_id,
            "wid": data.workspace_id,
            "name": data.name,
            "ptype": _TYPE_TO_DB[data.type],
            "desc": data.description,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="project.create",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=data.workspace_id,
            target_id=new_id,
            after={"name": data.name, "type": data.type},
        )
    )
    # 新規 project は canonical 9 工程の実レコードを持って開始する (T-UC-10)。
    # workflow サービスは projects に依存しないため循環は無いが、層の独立性を保つため
    # 関数内 import に留める。seed は冪等なので再入時も安全。
    from src.services.workflow import seed_default_phases

    await seed_default_phases(session, actor_id=actor_id, project_id=new_id)
    created = await get_project(session, new_id)
    if created is None:  # pragma: no cover - 直前に作成済
        raise RuntimeError("created project not visible after insert")
    return created


async def update_project(
    session: AsyncSession, *, actor_id: str, project_id: str, data: ProjectUpdate
) -> ProjectResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": project_id}
    if data.name is not None:
        sets.append("name = :name")
        params["name"] = data.name
    if data.client_name is not None:
        sets.append("client_name = :cname")
        params["cname"] = data.client_name
    if data.type is not None:
        sets.append("project_type = cast(:ptype as project_type_enum)")
        params["ptype"] = _TYPE_TO_DB[data.type]
    if data.status is not None:
        sets.append("status = cast(:st as project_status_enum)")
        params["st"] = _STATUS_TO_DB[data.status]
    if data.description is not None:
        sets.append(
            "settings = jsonb_set(settings, '{description}', to_jsonb(cast(:desc as text)))"
        )
        params["desc"] = data.description
    if not sets:
        return await get_project(session, project_id)

    res = await session.execute(
        text(
            f"update public.projects set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="project.update",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={k: v for k, v in params.items() if k != "id"},
        )
    )
    return await get_project(session, project_id)


async def delete_project(session: AsyncSession, *, actor_id: str, project_id: str) -> bool:
    """ソフト削除 (deleted_at)。1 行更新で True。"""
    res = await session.execute(
        text(
            "update public.projects set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": project_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="project.delete",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
        )
    )
    return True


async def restore_project(
    session: AsyncSession, *, actor_id: str, project_id: str
) -> ProjectResponse | None:
    """論理削除の取消 (deleted_at クリア)。削除から 30 日の猶予内のみ復元可能。

    猶予超過分は cron (T-F-20/T-A-40) が物理パージするが、未パージでも本層で
    30 日境界を強制し、対象外 (未削除 / 不在 / 猶予超過 / 権限なし) は None を返す。
    """
    res = await session.execute(
        text(
            "update public.projects set deleted_at = null "
            "where id = cast(:id as uuid) and deleted_at is not null "
            "and deleted_at > now() - interval '30 days' returning id"
        ),
        {"id": project_id},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="project.restore",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
        )
    )
    return await get_project(session, project_id)


async def get_dashboard(session: AsyncSession, project_id: str) -> ProjectDashboard | None:
    """project KPI ダッシュボード (T-A-11)。project が不可視なら RLS で None。

    - task_counts: lifecycle_stage 別 + total
    - recent_activities: project / その task に関する audit_logs (新しい順 10 件)
    """
    proj = await get_project(session, project_id)
    if proj is None:
        return None

    counts: dict[str, int] = {
        "triage": 0,
        "ready": 0,
        "in_progress": 0,
        "blocked": 0,
        "awaiting": 0,
        "done": 0,
    }
    cres = await session.execute(
        text(
            "select lifecycle_stage, count(*) as n from public.tasks "
            "where project_id = cast(:pid as uuid) and deleted_at is null "
            "group by lifecycle_stage"
        ),
        {"pid": project_id},
    )
    total = 0
    for row in cres.all():
        counts[str(row.lifecycle_stage)] = int(row.n)
        total += int(row.n)
    counts["total"] = total

    ares = await session.execute(
        text(
            "select action, actor_type, actor_id, target_type, target_id, created_at "
            "from public.audit_logs "
            "where target_id = cast(:pid as uuid) "
            "   or target_id in (select id from public.tasks where project_id = cast(:pid as uuid)) "
            "order by created_at desc limit 10"
        ),
        {"pid": project_id},
    )
    activities = [
        ActivityItem(
            action=str(r.action),
            actor_type=str(r.actor_type),
            actor_id=str(r.actor_id),
            target_type=str(r.target_type),
            target_id=(None if r.target_id is None else str(r.target_id)),
            created_at=r.created_at,
        )
        for r in ares.all()
    ]

    return ProjectDashboard(
        project_id=proj.id,
        name=proj.name,
        status=proj.status,
        current_phase=proj.current_phase,
        task_counts=counts,
        recent_activities=activities,
    )


async def set_project_ai_learning(
    session: AsyncSession, *, actor_id: str, project_id: str, opt_out: bool
) -> ProjectResponse | None:
    """project 単位の AI 学習オプトアウト (ai_training_optout) を更新 (T-A-13)。"""
    res = await session.execute(
        text(
            "update public.projects set ai_training_optout = :v "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"v": opt_out, "id": project_id},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="project.ai_learning_set",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={"ai_training_optout": opt_out},
        )
    )
    return await get_project(session, project_id)


async def set_account_ai_learning(
    session: AsyncSession, *, actor_id: str, opt_out: bool
) -> AccountAiLearning | None:
    """アカウント単位の AI 学習オプトアウト (users.ai_learning_opt_out) を self 更新 (T-A-13)。"""
    res = await session.execute(
        text(
            "update public.users set ai_learning_opt_out = :v "
            "where id = auth.uid() returning id, ai_learning_opt_out"
        ),
        {"v": opt_out},
    )
    row = res.first()
    if row is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="account.ai_learning_set",
            target_type="user",
            actor_type="user",
            actor_id=actor_id,
            target_id=str(row.id),
            after={"ai_learning_opt_out": opt_out},
        )
    )
    return AccountAiLearning(user_id=str(row.id), ai_learning_opt_out=bool(row.ai_learning_opt_out))
