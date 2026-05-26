"""Workspace CRUD サービス層 (T-A-06)。

RLS が効く AsyncSession (dependencies.get_rls_session) を受け取り、workspaces
テーブルへの操作を行う。可視性・権限は RLS policy (T-D-15) で enforce され、
本層は state-changing 操作で audit_logs に記録する (UBIQUITOUS AC)。

description は workspaces.settings JSONB の "description" キーに格納する
(E-002 に専用列が無いため)。member_count / project_count は集計で返す。
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.workspaces import WorkspaceCreate, WorkspaceResponse, WorkspaceUpdate

_SELECT_COLS = (
    "w.id, w.name, w.plan, w.settings ->> 'description' AS description, "
    "w.created_at, w.updated_at, w.deleted_at, "
    "(select count(*) from public.workspace_memberships m where m.workspace_id = w.id) AS member_count, "
    "(select count(*) from public.projects p where p.workspace_id = w.id and p.deleted_at is null) AS project_count"
)


def _row_to_response(row: Any) -> WorkspaceResponse:
    return WorkspaceResponse(
        id=str(row.id),
        name=str(row.name),
        description=(None if row.description is None else str(row.description)),
        member_count=int(row.member_count),
        project_count=int(row.project_count),
        plan=str(row.plan),
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_workspaces(session: AsyncSession) -> list[WorkspaceResponse]:
    """RLS で可視な (= 自分が member の) workspace 一覧。"""
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.workspaces w "
            "where w.deleted_at is null order by w.created_at"
        )
    )
    return [_row_to_response(r) for r in res.all()]


async def get_workspace(session: AsyncSession, workspace_id: str) -> WorkspaceResponse | None:
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.workspaces w "
            "where w.id = :id and w.deleted_at is null"
        ),
        {"id": workspace_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_workspace(
    session: AsyncSession, *, owner_user_id: str, data: WorkspaceCreate
) -> WorkspaceResponse:
    # id はクライアント生成にして RETURNING を使わない。
    # RETURNING は新行に SELECT(USING) policy も適用するが、作成時点では
    # owner membership がまだ無く current_user_workspaces() に乗らないため
    # RLS 上 unvisible となり失敗する。INSERT 後に get_workspace で取得する
    # (AFTER INSERT トリガが owner membership を作成済 → 可視)。
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.workspaces (id, owner_user_id, name, settings) "
            "values (cast(:id as uuid), :owner, :name, "
            "        jsonb_build_object('description', cast(:desc as text)))"
        ),
        {"id": new_id, "owner": owner_user_id, "name": data.name, "desc": data.description},
    )
    # owner membership は workspaces INSERT トリガ
    # (bootstrap_workspace_owner_membership, T-A-06 migration) が自動作成する。
    await AuditWriter(session).write(
        AuditEvent(
            action="workspace.create",
            target_type="workspace",
            actor_type="user",
            actor_id=owner_user_id,
            workspace_id=new_id,
            target_id=new_id,
            after={"name": data.name},
        )
    )
    created = await get_workspace(session, new_id)
    if created is None:  # pragma: no cover - 直前に作成済みのため通常到達しない
        raise RuntimeError("created workspace not visible after insert")
    return created


async def update_workspace(
    session: AsyncSession, *, actor_id: str, workspace_id: str, data: WorkspaceUpdate
) -> WorkspaceResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": workspace_id}
    if data.name is not None:
        sets.append("name = :name")
        params["name"] = data.name
    if data.description is not None:
        sets.append(
            "settings = jsonb_set(settings, '{description}', to_jsonb(cast(:desc as text)))"
        )
        params["desc"] = data.description
    if not sets:
        return await get_workspace(session, workspace_id)

    res = await session.execute(
        text(
            f"update public.workspaces set {', '.join(sets)} "
            "where id = :id and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="workspace.update",
            target_type="workspace",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=workspace_id,
            target_id=workspace_id,
            after={k: v for k, v in params.items() if k != "id"},
        )
    )
    return await get_workspace(session, workspace_id)


async def delete_workspace(session: AsyncSession, *, actor_id: str, workspace_id: str) -> bool:
    """ソフト削除 (deleted_at)。1 行更新で True。"""
    res = await session.execute(
        text(
            "update public.workspaces set deleted_at = now() "
            "where id = :id and deleted_at is null returning id"
        ),
        {"id": workspace_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="workspace.delete",
            target_type="workspace",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=workspace_id,
            target_id=workspace_id,
        )
    )
    return True
