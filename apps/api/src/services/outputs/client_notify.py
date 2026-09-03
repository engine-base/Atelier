"""成果物の新版をクライアントに知らせる (GAP-265 / 通し J21-05)。

クライアントポータルに招待済み (未失効・未期限切れ・view スコープ) のクライアントへ、
成果物の新しい版が積まれたことをメールで知らせ、監査ログ `client_notified_of_update` を残す。

- best-effort: メール送信の失敗で本体 (版の作成) を落とさない
- ATELIER_EMAIL_API_KEY 未設定 / DRY_RUN では ResendSender が dry-run を返す (送信痕跡は監査ログに残る)
- 本文に成果物の中身は入れない (ポータルで見てもらう)。案件名と版番号だけ
"""

from __future__ import annotations

import html
import json
import logging
import os

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.email.sender import EmailMessage, ResendSender
from src.schemas.outputs import OutputResponse

logger = logging.getLogger(__name__)

# audit_logs.action は「<対象>.<出来事>」形式 (DB の CHECK 制約)
AUDIT_ACTION = "output.client_notified_of_update"


def _portal_link(project_id: str) -> str:
    base = os.environ.get("ATELIER_WEB_BASE_URL") or os.environ.get("ATELIER_PUBLIC_WEB_URL") or ""
    return f"{base.rstrip('/')}/portal?project={project_id}" if base else "/portal"


async def notify_clients_of_new_version(
    session: AsyncSession, *, output: OutputResponse, actor_id: str
) -> int:
    """招待済みクライアントへ更新メールを送り、監査ログを書く。返り値 = 通知した件数。

    actor_id = 版を積んだ利用者。audit_logs の RLS (actor_type='user' かつ actor_id=auth.uid())
    に合わせて、その利用者の行為として記録する。"""
    try:
        rows = (
            await session.execute(
                text(
                    "select ci.id, ci.email, ci.client_display_name, ci.scopes, p.name as project_name "
                    "from public.client_invitations ci "
                    "join public.projects p on p.id = ci.project_id "
                    "where ci.project_id = cast(:pid as uuid) and ci.revoked_at is null "
                    "and (ci.expires_at is null or ci.expires_at > now()) and p.deleted_at is null"
                ),
                {"pid": output.project_id},
            )
        ).all()
    except Exception:  # pragma: no cover - 通知は本体を止めない
        logger.exception("client notify: invitation lookup failed for output %s", output.id)
        return 0
    notified = 0
    for row in rows:
        scopes_raw = row.scopes
        scopes = json.loads(scopes_raw) if isinstance(scopes_raw, str) else (scopes_raw or ["view"])
        if "view" not in [str(s) for s in scopes]:
            continue
        project_name = str(row.project_name)
        greeting = (
            html.escape(str(row.client_display_name).strip())
            if row.client_display_name
            else "ご担当者"
        )
        link = _portal_link(str(output.project_id))
        subject = f"【Atelier】「{project_name}」の成果物が更新されました (v{output.version})"
        body_html = (
            f"<p>{greeting} 様</p>"
            f"<p>「{html.escape(project_name)}」の成果物に新しい版 (v{output.version}) が追加されました。</p>"
            f'<p><a href="{html.escape(link)}">クライアントポータル</a>でご確認ください。</p>'
        )
        body_text = (
            f"{row.client_display_name or 'ご担当者'} 様\n\n"
            f"「{project_name}」の成果物に新しい版 (v{output.version}) が追加されました。\n"
            f"クライアントポータルでご確認ください: {link}\n"
        )
        try:
            result = await ResendSender().send(
                EmailMessage(to=(str(row.email),), subject=subject, html=body_html, text=body_text)
            )
        except Exception:  # pragma: no cover - best-effort
            logger.exception("client notify: send failed to invitation %s", row.id)
            continue
        await AuditWriter(session).write(
            AuditEvent(
                action=AUDIT_ACTION,
                target_type="workflow_output",
                actor_type="user",
                actor_id=actor_id,
                target_id=str(output.id),
                after={
                    "invitation_id": str(row.id),
                    "version": output.version,
                    "dry_run": bool(result.dry_run),
                    "email_id": result.id,
                },
            )
        )
        notified += 1
    return notified
