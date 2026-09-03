"""ワークスペース招待リンク (GAP-315 / 通し J31-08)。

これまでの招待は「登録済みのメールなら即 membership を足す」だけだった。
まだ Atelier を使っていない人は **招待できず 422 で終わり**で、正本が期待する
「期限 7 日の招待リンク → 登録 → 参加」という筋道が存在しなかった。

設計は client_invitations (クライアントポータル) と同じ:

- サーバーは **sha256 ハッシュだけ**を持つ。生トークンは発行直後の応答とメールにしか出ない
- 既定 7 日で期限切れ。`revoke` で即失効。1 回使ったら再利用できない
- 招待は **送った宛先のメールにひも付く**。リンクを拾った別人が登録しても参加できない
  (これを外すと、リンクを知る全員が入れる = R-T08 の隣で致命的)
- 受け取り側 (まだメンバーでない人) の照会・承諾は RLS を通せないので service 経路。
  「トークンを知っていること」が本人性の証明で、宛先メールの一致で二重に縛る
"""

from __future__ import annotations

import hashlib
import html
import logging
import os
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.db.session import shared_session_factory
from src.email.sender import EmailMessage, ResendSender

logger = logging.getLogger(__name__)

DEFAULT_TTL_DAYS = 7


class InvitationError(Exception):
    """招待を受け取れない理由。code は画面のメッセージ分岐に使う。

    not_found / expired / revoked / already_accepted / email_mismatch /
    already_member
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class InvitationSummary:
    id: str
    workspace_id: str
    workspace_name: str
    email: str
    role: str
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    invited_by_name: str | None


def _hash(raw_token: str) -> str:
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def invitation_link(raw_token: str) -> str:
    base = os.environ.get("ATELIER_WEB_BASE_URL") or os.environ.get("ATELIER_PUBLIC_WEB_URL") or ""
    path = f"/invite/{raw_token}"
    return f"{base.rstrip('/')}{path}" if base else path


async def create_invitation(
    session: AsyncSession,
    *,
    actor_id: str,
    workspace_id: str,
    email: str,
    role: str,
    ttl_days: int = DEFAULT_TTL_DAYS,
) -> tuple[str, InvitationSummary]:
    """招待リンクを発行して (生トークン, 概要) を返す。

    同じ宛先に生きている招待があれば **先に失効させてから**新しく出す
    (部分ユニーク索引 workspace_invitations_live_unique と整合させる)。
    重複を許すと「どのリンクが生きているのか」が誰にも分からなくなる。
    """
    await session.execute(
        text(
            "update public.workspace_invitations set revoked_at = now(), updated_at = now() "
            "where workspace_id = cast(:wid as uuid) and lower(email) = lower(:em) "
            "  and accepted_at is null and revoked_at is null"
        ),
        {"wid": workspace_id, "em": email},
    )
    raw_token = secrets.token_urlsafe(32)
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.workspace_invitations "
            "(id, workspace_id, email, role, token_hash, expires_at, invited_by) "
            "values (cast(:id as uuid), cast(:wid as uuid), :em, "
            "        cast(:role as workspace_member_role_enum), :th, "
            "        now() + make_interval(days => :ttl), cast(:by as uuid))"
        ),
        {
            "id": new_id,
            "wid": workspace_id,
            "em": email,
            "role": role,
            "th": _hash(raw_token),
            "ttl": ttl_days,
            "by": actor_id,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="workspace_invitation.create",
            target_type="workspace_invitation",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=workspace_id,
            target_id=new_id,
            after={"email": email, "role": role, "ttl_days": ttl_days},
        )
    )
    summary = await _summary_by_id(session, new_id)
    if summary is None:  # pragma: no cover - 直前に作成済
        raise RuntimeError("created invitation not visible after insert")
    await _send_invitation_email(summary=summary, link=invitation_link(raw_token))
    return raw_token, summary


_SUMMARY_COLS = (
    "i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, "
    "w.name as workspace_name, public.user_display_name(i.invited_by) as invited_by_name"
)


def _to_summary(row: Any) -> InvitationSummary:
    return InvitationSummary(
        id=str(row.id),
        workspace_id=str(row.workspace_id),
        workspace_name=str(row.workspace_name),
        email=str(row.email),
        role=str(row.role),
        expires_at=row.expires_at,
        accepted_at=row.accepted_at,
        revoked_at=row.revoked_at,
        invited_by_name=(None if row.invited_by_name is None else str(row.invited_by_name)),
    )


async def _summary_by_id(session: AsyncSession, invitation_id: str) -> InvitationSummary | None:
    row = (
        await session.execute(
            text(
                f"select {_SUMMARY_COLS} from public.workspace_invitations i "
                "join public.workspaces w on w.id = i.workspace_id "
                "where i.id = cast(:id as uuid)"
            ),
            {"id": invitation_id},
        )
    ).first()
    return None if row is None else _to_summary(row)


async def list_invitations(session: AsyncSession, workspace_id: str) -> list[InvitationSummary]:
    """まだ受け取られていない招待 (期限切れも含む) を新しい順で返す。

    期限切れを隠さない — 「送ったのに返事がない」のか「切れていた」のかが
    分からないと、再送すべきかどうかを判断できない。
    """
    res = await session.execute(
        text(
            f"select {_SUMMARY_COLS} from public.workspace_invitations i "
            "join public.workspaces w on w.id = i.workspace_id "
            "where i.workspace_id = cast(:wid as uuid) and i.accepted_at is null "
            "  and i.revoked_at is null "
            "order by i.created_at desc limit 100"
        ),
        {"wid": workspace_id},
    )
    return [_to_summary(r) for r in res.all()]


async def revoke_invitation(
    session: AsyncSession, *, actor_id: str, workspace_id: str, invitation_id: str
) -> bool:
    res = await session.execute(
        text(
            "update public.workspace_invitations set revoked_at = now(), updated_at = now() "
            "where id = cast(:id as uuid) and workspace_id = cast(:wid as uuid) "
            "  and accepted_at is null and revoked_at is null returning id"
        ),
        {"id": invitation_id, "wid": workspace_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="workspace_invitation.revoke",
            target_type="workspace_invitation",
            actor_type="user",
            actor_id=actor_id,
            workspace_id=workspace_id,
            target_id=invitation_id,
        )
    )
    return True


async def preview_invitation(raw_token: str) -> InvitationSummary:
    """リンクを開いた人に「どこへの招待か」を見せる (未サインインでも可)。

    期限切れ / 失効 / 使用済みは、ここで理由つきで弾く。開いた瞬間に理由が
    分からないと、受け取った人は「壊れている」としか思えない。
    """
    factory = shared_session_factory()
    async with factory() as session:
        summary = await _summary_by_token(session, raw_token)
        _require_live(summary)
        return summary


async def accept_invitation(*, raw_token: str, user_id: str) -> InvitationSummary:
    """サインイン済みの本人が招待を受け取る (membership を作る)。

    宛先メールと本人のメールが一致しないと拒否する。トークンを拾った別人が
    参加できてしまうと、招待リンクが「誰でも入れる裏口」になる。
    """
    factory = shared_session_factory()
    async with factory() as session:
        summary = await _summary_by_token(session, raw_token)
        _require_live(summary)
        me = (
            await session.execute(
                text("select email from public.users where id = cast(:u as uuid)"),
                {"u": user_id},
            )
        ).first()
        if me is None or str(me.email).lower() != summary.email.lower():
            raise InvitationError(
                "email_mismatch",
                "この招待は別のメールアドレス宛です。招待されたアドレスでサインインしてください。",
            )
        already = (
            await session.execute(
                text(
                    "select 1 from public.workspace_memberships "
                    "where workspace_id = cast(:w as uuid) and user_id = cast(:u as uuid)"
                ),
                {"w": summary.workspace_id, "u": user_id},
            )
        ).first()
        if already is None:
            await session.execute(
                text(
                    "insert into public.workspace_memberships (workspace_id, user_id, role) "
                    "values (cast(:w as uuid), cast(:u as uuid), "
                    "        cast(:r as workspace_member_role_enum))"
                ),
                {"w": summary.workspace_id, "u": user_id, "r": summary.role},
            )
        await session.execute(
            text(
                "update public.workspace_invitations "
                "set accepted_at = now(), accepted_user_id = cast(:u as uuid), updated_at = now() "
                "where id = cast(:id as uuid)"
            ),
            {"u": user_id, "id": summary.id},
        )
        await AuditWriter(session).write(
            AuditEvent(
                action="workspace_invitation.accept",
                target_type="workspace_invitation",
                actor_type="user",
                actor_id=user_id,
                workspace_id=summary.workspace_id,
                target_id=summary.id,
                after={"role": summary.role, "already_member": already is not None},
            )
        )
        await session.commit()
        return summary


async def _summary_by_token(session: AsyncSession, raw_token: str) -> InvitationSummary:
    row = (
        await session.execute(
            text(
                f"select {_SUMMARY_COLS} from public.workspace_invitations i "
                "join public.workspaces w on w.id = i.workspace_id and w.deleted_at is null "
                "where i.token_hash = :th"
            ),
            {"th": _hash(raw_token)},
        )
    ).first()
    if row is None:
        raise InvitationError("not_found", "この招待リンクは無効です。")
    return _to_summary(row)


def _require_live(summary: InvitationSummary) -> None:
    from datetime import UTC

    if summary.accepted_at is not None:
        raise InvitationError("already_accepted", "この招待はすでに使われています。")
    if summary.revoked_at is not None:
        raise InvitationError("revoked", "この招待は取り消されています。")
    expires = summary.expires_at
    if expires.tzinfo is None:  # pragma: no cover - DB は timestamptz
        expires = expires.replace(tzinfo=UTC)
    if expires <= datetime.now(UTC):
        raise InvitationError(
            "expired", "この招待リンクは期限切れです。招待した人にもう一度送ってもらってください。"
        )


async def _send_invitation_email(*, summary: InvitationSummary, link: str) -> None:
    """招待リンクをメールで送る (best-effort)。失敗しても招待の発行は成立させる
    (トークンは発行時の応答にも入るので、運営が手で共有できる)。"""
    role_label = {"owner": "オーナー", "member": "メンバー", "viewer": "閲覧者"}.get(
        summary.role, summary.role
    )
    inviter = summary.invited_by_name or "メンバー"
    subject = f"【Atelier】「{summary.workspace_name}」に招待されました"
    body_html = (
        f"<p>{html.escape(inviter)} さんがあなたを「{html.escape(summary.workspace_name)}」に"
        f"{html.escape(role_label)}として招待しました。</p>"
        f'<p><a href="{html.escape(link)}">招待を受け取る</a></p>'
        f"<p>このリンクの期限は {summary.expires_at:%Y-%m-%d %H:%M} です。"
        "Atelier のアカウントがまだ無い場合は、このアドレスで登録してから開いてください。</p>"
    )
    body_text = (
        f"{inviter} さんがあなたを「{summary.workspace_name}」に{role_label}として招待しました。\n\n"
        f"招待を受け取る: {link}\n"
        f"期限: {summary.expires_at:%Y-%m-%d %H:%M}\n"
        "Atelier のアカウントがまだ無い場合は、このアドレスで登録してから開いてください。\n"
    )
    try:
        await ResendSender().send(
            EmailMessage(to=(summary.email,), subject=subject, html=body_html, text=body_text)
        )
    except Exception:  # pragma: no cover - best-effort
        logger.exception("workspace invitation mail failed for %s", summary.id)
