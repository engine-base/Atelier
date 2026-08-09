"""運営サポート連絡 サービス層 (GAP-031⑥ — S-T04)。

運営 admin がユーザー (退会予約中の soft-delete 済みも含む) へサポートメールを
送る。送信は既存の ResendSender (ATELIER_EMAIL_* 未設定環境は dry-run — 偽装
せず dry_run フラグで応答に明示する)。送信は audit_logs `support.contact` に
記録し、「最近のサポート対応」一覧はこの実 audit から逆引きする。
"""

from __future__ import annotations

import asyncio
import html as html_mod
import json
from functools import lru_cache
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.db.session import create_engine, create_session_factory
from src.email.sender import EmailMessage, ResendSender
from src.schemas.support import SupportContactItem, SupportContactResponse


@lru_cache(maxsize=8)
def _session_factory_for_loop(loop_key: int) -> async_sessionmaker[AsyncSession]:
    """service_role 相当の sessionmaker (skills service と同パターン)。"""
    del loop_key
    return create_session_factory(create_engine())


def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    return _session_factory_for_loop(id(asyncio.get_running_loop()))


_service_session_factory.cache_clear = (  # pyright: ignore[reportAttributeAccessIssue, reportFunctionMemberAccess]
    _session_factory_for_loop.cache_clear
)


async def send_support_contact(
    *, actor_id: str, user_id: str, subject: str, message: str
) -> SupportContactResponse | None:
    """ユーザーへサポートメールを送る。ユーザー不在なら None (route が 404)。

    退会予約中 (deleted_at 有り) のユーザーも対象 (モックの主ユースケース —
    削除予定前の連絡)。本文はプレーンテキスト由来を escape した HTML で送る。
    """
    async with _service_session_factory()() as session:
        res = await session.execute(
            text("select email, display_name from public.users where id = cast(:i as uuid)"),
            {"i": user_id},
        )
        row = res.first()
        if row is None:
            return None
        to_email = str(row.email)
        escaped = html_mod.escape(message).replace("\n", "<br>")
        result = await ResendSender().send(
            EmailMessage(
                to=(to_email,),
                subject=subject,
                html=f"<p>{escaped}</p>",
                text=message,
                tags=(("kind", "support_contact"),),
            )
        )
        await AuditWriter(session).write(
            AuditEvent(
                action="support.contact",
                target_type="user",
                actor_type="user",
                actor_id=actor_id,
                target_id=user_id,
                after={
                    "subject": subject,
                    "to_email": to_email,
                    "dry_run": result.dry_run,
                    "email_id": result.id,
                },
            )
        )
        await session.commit()
    return SupportContactResponse(to_email=to_email, dry_run=result.dry_run)


async def list_recent_contacts(*, limit: int = 10) -> list[SupportContactItem]:
    """「最近のサポート対応」— 実 audit (support.contact) からの逆引き。"""
    async with _service_session_factory()() as session:
        res = await session.execute(
            text(
                "select al.after, al.created_at, u.display_name "
                "from public.audit_logs al "
                "left join public.users u on u.id = al.target_id "
                "where al.action = 'support.contact' "
                "order by al.created_at desc limit :lim"
            ),
            {"lim": max(1, min(limit, 50))},
        )
        items: list[SupportContactItem] = []
        for row in res.all():
            raw: Any = row.after
            after: dict[str, Any] = json.loads(raw) if isinstance(raw, str) else (raw or {})
            items.append(
                SupportContactItem(
                    to_email=str(after.get("to_email", "")),
                    display_name=(None if row.display_name is None else str(row.display_name)),
                    subject=str(after.get("subject", "")),
                    created_at=row.created_at,
                )
            )
        return items
