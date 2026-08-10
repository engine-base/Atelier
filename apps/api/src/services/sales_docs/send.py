# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""S-N01 ドラフトのメール送信 + 送信履歴 (GAP-018)。

既存 ResendSender で実送信し、sales_doc_sends に履歴を記録する。
メール未設定環境は dry_run=true を偽装せず応答・履歴の両方で明示する
(S-T04 サポート連絡と同じ原則)。
"""

from __future__ import annotations

import html as html_mod
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.email.sender import EmailMessage, ResendSender
from src.schemas.sales_docs import SalesDocSendRequest, SalesDocSendResponse

from . import get_sales_doc, is_uuid
from .generate import DOC_TYPE_LABEL

_COLS = "id, doc_id, to_email, subject, dry_run, created_at"


def _row(row: Any) -> SalesDocSendResponse:
    return SalesDocSendResponse(
        id=str(row.id),
        doc_id=str(row.doc_id),
        to_email=str(row.to_email),
        subject=str(row.subject),
        dry_run=bool(row.dry_run),
        created_at=row.created_at,
    )


async def list_sends(session: AsyncSession, doc_id: str) -> list[SalesDocSendResponse]:
    if not is_uuid(doc_id):
        return []
    res = await session.execute(
        text(
            f"select {_COLS} from public.sales_doc_sends "
            "where doc_id = cast(:id as uuid) order by created_at desc"
        ),
        {"id": doc_id},
    )
    return [_row(r) for r in res.all()]


async def send_doc(
    session: AsyncSession,
    *,
    actor_id: str,
    doc_id: str,
    data: SalesDocSendRequest,
    sender: ResendSender | None = None,
) -> SalesDocSendResponse | None:
    """ドラフトをメール送信し履歴を記録する。None = doc 不可視/不在。"""
    doc = await get_sales_doc(session, doc_id)
    if doc is None:
        return None

    label = DOC_TYPE_LABEL.get(doc.doc_type, doc.doc_type)
    body = doc.summary or ""
    first_line = (body.splitlines()[0] if body else "").lstrip("# ").strip() or label
    subject = data.subject or f"【{label}ドラフト】{first_line}"

    greeting = f"<p>{html_mod.escape(data.message)}</p>" if data.message else ""
    html_body = (
        f"{greeting}"
        f'<pre style="font-family:sans-serif;white-space:pre-wrap;'
        f'line-height:1.8;font-size:14px;">{html_mod.escape(body)}</pre>'
        '<p style="color:#6B7280;font-size:12px;">'
        "※ 本ドラフトは AI 補助で作成されています。最終版は人間レビュー後に確定されます。</p>"
    )

    result = await (sender or ResendSender()).send(
        EmailMessage(
            to=(data.to_email,),
            subject=subject,
            html=html_body,
            text=(f"{data.message}\n\n" if data.message else "") + body,
            tags=(("category", "sales_doc"), ("doc_type", doc.doc_type)),
        )
    )

    row = await session.execute(
        text(
            "insert into public.sales_doc_sends (doc_id, to_email, subject, dry_run, sent_by) "
            "values (cast(:did as uuid), :to, :sub, :dry, cast(:by as uuid)) "
            f"returning {_COLS}"
        ),
        {
            "did": doc_id,
            "to": data.to_email,
            "sub": subject,
            "dry": result.dry_run,
            "by": actor_id,
        },
    )
    created = _row(row.one())
    await AuditWriter(session).write(
        AuditEvent(
            action="sales_doc.send",
            target_type="workflow_output",
            actor_type="user",
            actor_id=actor_id,
            target_id=doc_id,
            after={
                "send_id": created.id,
                "to_email": data.to_email,
                "subject": subject,
                "dry_run": result.dry_run,
            },
        )
    )
    return created
