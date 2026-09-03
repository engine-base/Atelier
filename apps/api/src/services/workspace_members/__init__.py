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

# GAP-315: 未登録の宛先は 422 で終わりにせず、期限つきの招待リンクを出す ("invited")
InviteStatus = Literal["ok", "invited", "not_registered", "forbidden", "already_member"]


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
        # GAP-315 (通し J31-08): 未登録の相手も招待できるようにする。
        # ここで 422 を返して終わるのが、「まだ使っていない人を呼べない」の正体だった。
        if not await _caller_is_owner(session, workspace_id):
            return ("forbidden", None)
        from src.services.workspace_invitations import create_invitation

        await create_invitation(
            session, actor_id=actor_id, workspace_id=workspace_id, email=email, role=role
        )
        return ("invited", None)
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
    await _send_invite_mail(
        session, actor_id=actor_id, workspace_id=workspace_id, email=email, role=role
    )
    members = await list_members(session, workspace_id)
    detail = next((m for m in members if m.user_id == str(user_id)), None)
    return ("ok", detail)


async def _send_invite_mail(
    session: AsyncSession, *, actor_id: str, workspace_id: str, email: str, role: str
) -> None:
    """GAP-281 (通し J31-01): 招待した相手にメールで知らせる (best-effort)。

    以前は membership を足すだけで、相手には何も届かなかった。本文は WS 名と
    招待者名だけ (秘密は載せない)。送信の痕跡は監査ログに残す (dry-run 含む)。
    """
    import html
    import logging
    import os

    from src.email.sender import EmailMessage, ResendSender

    logger = logging.getLogger(__name__)
    try:
        row = (
            await session.execute(
                text(
                    "select w.name as workspace_name, u.display_name as inviter_name "
                    "from public.workspaces w "
                    "left join public.users u on u.id = cast(:a as uuid) "
                    "where w.id = cast(:wid as uuid)"
                ),
                {"wid": workspace_id, "a": actor_id},
            )
        ).first()
        ws_name = str(row.workspace_name) if row is not None else "ワークスペース"
        inviter = str(row.inviter_name) if row is not None and row.inviter_name else "メンバー"
        base = (
            os.environ.get("ATELIER_WEB_BASE_URL") or os.environ.get("ATELIER_PUBLIC_WEB_URL") or ""
        )
        link = f"{base.rstrip('/')}/projects" if base else "/projects"
        role_label = {"owner": "オーナー", "member": "メンバー", "viewer": "閲覧者"}.get(role, role)
        subject = f"【Atelier】「{ws_name}」に招待されました"
        body_html = (
            f"<p>{html.escape(inviter)} さんがあなたを「{html.escape(ws_name)}」に"
            f"{html.escape(role_label)}として招待しました。</p>"
            f'<p><a href="{html.escape(link)}">Atelier を開く</a> (登録済みのメールアドレスでサインインしてください)</p>'
        )
        body_text = (
            f"{inviter} さんがあなたを「{ws_name}」に{role_label}として招待しました。\n"
            f"Atelier を開く: {link}\n"
        )
        result = await ResendSender().send(
            EmailMessage(to=(email,), subject=subject, html=body_html, text=body_text)
        )
        await AuditWriter(session).write(
            AuditEvent(
                action="workspace_member.invite_mail",
                target_type="workspace_membership",
                actor_type="user",
                actor_id=actor_id,
                workspace_id=workspace_id,
                after={"email": email, "dry_run": bool(result.dry_run), "email_id": result.id},
            )
        )
    except Exception:  # pragma: no cover - 通知の失敗で招待自体は落とさない
        logger.exception("invite mail failed for workspace %s", workspace_id)


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


class LastOwnerError(Exception):
    """GAP-272: 最後の owner は外せない (外すと誰も WS を管理できなくなる)。"""


async def remove_member(
    session: AsyncSession, *, actor_id: str, workspace_id: str, user_id: str
) -> bool:
    # GAP-272 (通し J36-06): 唯一の owner の除名は「静かに何もしない 204」ではなく
    # 明示的に拒否する。owner が 0 人の WS は誰も管理できない。
    owners = (
        await session.execute(
            text(
                "select count(*) filter (where role = 'owner') as owners, "
                "bool_or(user_id = cast(:uid as uuid) and role = 'owner') as target_is_owner "
                "from public.workspace_memberships where workspace_id = cast(:wid as uuid)"
            ),
            {"wid": workspace_id, "uid": user_id},
        )
    ).one()
    if bool(owners.target_is_owner) and int(owners.owners) <= 1:
        raise LastOwnerError("cannot remove the last owner")
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
