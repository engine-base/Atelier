"""WS メンバー管理 サービス層 (T-A-07)。

workspace_memberships の招待 (email→user 解決)・ロール変更・削除。
可視性/権限は RLS (T-D-14) + helper 関数 (T-A-07 migration, membership-gated definer)。
状態変更で audit_logs 記録。
"""

from __future__ import annotations

from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.workspace_members import MemberResponse

InviteStatus = Literal["ok", "not_registered", "forbidden", "already_member"]


def _row_to_response(workspace_id: str, row: Any) -> MemberResponse:
    return MemberResponse(
        workspace_id=workspace_id,
        user_id=str(row.user_id),
        email=str(row.email),
        display_name=(None if row.display_name is None else str(row.display_name)),
        role=row.role,
        joined_at=row.joined_at,
    )


async def list_members(session: AsyncSession, workspace_id: str) -> list[MemberResponse]:
    """membership-gated definer 関数でメンバー詳細を取得 (非メンバーは 0 行)。"""
    res = await session.execute(
        text("select * from public.workspace_member_details(cast(:wid as uuid))"),
        {"wid": workspace_id},
    )
    return [_row_to_response(workspace_id, r) for r in res.all()]


async def _caller_is_owner(session: AsyncSession, workspace_id: str) -> bool:
    res = await session.execute(
        text(
            "select exists(select 1 from public.workspace_memberships "
            "where workspace_id = cast(:wid as uuid) and user_id = auth.uid() and role = 'owner')"
        ),
        {"wid": workspace_id},
    )
    return bool(res.scalar_one())


async def invite_member(
    session: AsyncSession, *, actor_id: str, workspace_id: str, email: str, role: str
) -> tuple[InviteStatus, MemberResponse | None]:
    uid_res = await session.execute(
        text("select public.resolve_user_id_by_email(:email)"), {"email": email}
    )
    user_id = uid_res.scalar_one_or_none()
    if user_id is None:
        return ("not_registered", None)
    if not await _caller_is_owner(session, workspace_id):
        return ("forbidden", None)
    exists = await session.execute(
        text(
            "select 1 from public.workspace_memberships "
            "where workspace_id = cast(:wid as uuid) and user_id = cast(:uid as uuid)"
        ),
        {"wid": workspace_id, "uid": str(user_id)},
    )
    if exists.first() is not None:
        return ("already_member", None)

    await session.execute(
        text(
            "insert into public.workspace_memberships (workspace_id, user_id, role) "
            "values (cast(:wid as uuid), cast(:uid as uuid), cast(:role as workspace_member_role_enum))"
        ),
        {"wid": workspace_id, "uid": str(user_id), "role": role},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="workspace_member.invite",
            target_type="workspace_membership",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=workspace_id,
            target_id=str(user_id),
            after={"email": email, "role": role},
        )
    )
    members = await list_members(session, workspace_id)
    detail = next((m for m in members if m.user_id == str(user_id)), None)
    return ("ok", detail)


async def update_role(
    session: AsyncSession, *, actor_id: str, workspace_id: str, user_id: str, role: str
) -> MemberResponse | None:
    res = await session.execute(
        text(
            "update public.workspace_memberships "
            "set role = cast(:role as workspace_member_role_enum) "
            "where workspace_id = cast(:wid as uuid) and user_id = cast(:uid as uuid) "
            "returning user_id"
        ),
        {"wid": workspace_id, "uid": user_id, "role": role},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="workspace_member.role_update",
            target_type="workspace_membership",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=workspace_id,
            target_id=user_id,
            after={"role": role},
        )
    )
    members = await list_members(session, workspace_id)
    return next((m for m in members if m.user_id == user_id), None)


async def remove_member(
    session: AsyncSession, *, actor_id: str, workspace_id: str, user_id: str
) -> bool:
    res = await session.execute(
        text(
            "delete from public.workspace_memberships "
            "where workspace_id = cast(:wid as uuid) and user_id = cast(:uid as uuid) "
            "returning user_id"
        ),
        {"wid": workspace_id, "uid": user_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="workspace_member.remove",
            target_type="workspace_membership",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=workspace_id,
            target_id=user_id,
        )
    )
    return True
