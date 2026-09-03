"""クライアントのコメントを運営 (ワークスペースの所有者) に知らせる (GAP-266 / 通し J23-01)。

クライアントポータルでコメントが投稿されても、運営側には何も届かなかった。
コメントは「クライアントから運営への連絡」なので、届かなければ機能として成立しない。

- 宛先: 案件のワークスペース所有者 (owner_user_id) + 所属 role='owner' の利用者 (退会済は除く)
- best-effort: メール送信の失敗で本体 (コメントの保存) を落とさない
- ATELIER_EMAIL_API_KEY 未設定 / DRY_RUN では ResendSender が dry-run を返す (送信痕跡は監査ログに残る)
- 本文にコメント全文は入れない (先頭 200 文字まで)。詳細はツール内で見てもらう
- 監査ログ `client.comment.staff_notified` を、コメント投稿と同じ actor (client:<招待 ID>) で残す
"""

from __future__ import annotations

import html
import logging
import os

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.email.sender import EmailMessage, ResendSender

logger = logging.getLogger(__name__)

# audit_logs.action は「<対象>.<出来事>」形式 (DB の CHECK 制約)
AUDIT_ACTION = "client.comment.staff_notified"
_EXCERPT_CHARS = 200


def _staff_link(project_id: str) -> str:
    base = os.environ.get("ATELIER_WEB_BASE_URL") or os.environ.get("ATELIER_PUBLIC_WEB_URL") or ""
    path = f"/projects/dashboard?project={project_id}"
    return f"{base.rstrip('/')}{path}" if base else path


def _excerpt(content: str) -> str:
    body = content.strip()
    return body if len(body) <= _EXCERPT_CHARS else body[:_EXCERPT_CHARS] + "…"


async def notify_staff_of_client_comment(
    session: AsyncSession,
    *,
    project_id: str,
    invitation_id: str,
    comment_id: str,
    target_label: str | None,
    content: str,
) -> int:
    """運営へ通知メールを送り、監査ログを書く。返り値 = 通知した件数。"""
    try:
        rows = (
            await session.execute(
                text(
                    "select distinct u.id, u.email, u.display_name, "
                    "p.name as project_name, ci.email as client_email, "
                    "ci.client_display_name "
                    "from public.projects p "
                    "join public.workspaces w on w.id = p.workspace_id "
                    "join public.client_invitations ci on ci.id = cast(:inv as uuid) "
                    "join public.users u on u.deleted_at is null and ("
                    "  u.id = w.owner_user_id or u.id in ("
                    "    select wm.user_id from public.workspace_memberships wm "
                    "    where wm.workspace_id = w.id and wm.role = 'owner')) "
                    "where p.id = cast(:pid as uuid) and p.deleted_at is null"
                ),
                {"pid": project_id, "inv": invitation_id},
            )
        ).all()
    except Exception:  # pragma: no cover - 通知は本体を止めない
        logger.exception("staff notify: recipient lookup failed for comment %s", comment_id)
        return 0
    notified = 0
    for row in rows:
        project_name = str(row.project_name)
        client_name = (
            str(row.client_display_name).strip()
            if row.client_display_name
            else str(row.client_email)
        )
        where = f"（{target_label}）" if target_label else ""
        link = _staff_link(project_id)
        excerpt = _excerpt(content)
        subject = f"【Atelier】「{project_name}」にクライアントからコメントが届きました"
        body_html = (
            f"<p>{html.escape(str(row.display_name or 'ご担当者'))} 様</p>"
            f"<p>「{html.escape(project_name)}」{html.escape(where)}に "
            f"{html.escape(client_name)} さんからコメントが届きました。</p>"
            f"<blockquote>{html.escape(excerpt)}</blockquote>"
            f'<p><a href="{html.escape(link)}">Atelier で確認する</a></p>'
        )
        body_text = (
            f"{row.display_name or 'ご担当者'} 様\n\n"
            f"「{project_name}」{where}に {client_name} さんからコメントが届きました。\n\n"
            f"{excerpt}\n\n"
            f"Atelier で確認する: {link}\n"
        )
        try:
            result = await ResendSender().send(
                EmailMessage(to=(str(row.email),), subject=subject, html=body_html, text=body_text)
            )
        except Exception:  # pragma: no cover - best-effort
            logger.exception("staff notify: send failed to user %s", row.id)
            continue
        await AuditWriter(session).write(
            AuditEvent(
                action=AUDIT_ACTION,
                target_type="comment",
                actor_type="anonymous",
                actor_id=f"client:{invitation_id}",
                target_id=comment_id,
                after={
                    "project_id": project_id,
                    "recipient_user_id": str(row.id),
                    "dry_run": bool(result.dry_run),
                    "email_id": result.id,
                },
            )
        )
        notified += 1
    return notified
