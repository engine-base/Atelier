"""クライアント招待管理 サービス層 (T-A-34)。

RLS が効く AsyncSession を受け取り client_invitations を操作する。可視性/権限は
RLS (T-A-34 migration: 所属 workspace の project の招待を member が CRUD)。
token は raw を生成時のみ返し、DB には SHA-256 hash を保存。状態変更で audit_logs。
"""

from __future__ import annotations

import contextlib
import hashlib
import html
import json
import os
import secrets
import uuid
from datetime import UTC, datetime
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.email.sender import EmailMessage, ResendSender
from src.schemas.client_invitations import (
    InvitationCreate,
    InvitationCreateResponse,
    InvitationResponse,
)


def _invitation_link(raw_token: str) -> str:
    """招待メール/共有用のサインインリンク。ATELIER_PUBLIC_BASE_URL が信頼源。

    フロント /portal/signin は ?token= をプレフィルするので、受け手はクリックだけで
    サインイン画面にトークンが入った状態になる。
    """
    base = os.environ.get("ATELIER_PUBLIC_BASE_URL", "https://atelier.example.com")
    from urllib.parse import quote

    return f"{base.rstrip('/')}/portal/signin?token={quote(raw_token, safe='')}"


async def _send_invitation_email(*, email: str, link: str, client_display_name: str | None) -> None:
    """クライアント招待メールを送信する (best-effort)。

    ATELIER_EMAIL_API_KEY 未設定 / DRY_RUN 時は ResendSender が dry-run を返すため
    実送信されない。呼び出し側は例外を握り潰し、招待作成の成否には影響させない。
    """
    greeting = html.escape(client_display_name.strip()) if client_display_name else "ご担当者"
    safe_link = html.escape(link)
    body_html = (
        f"<p>{greeting} 様</p>"
        "<p>プロジェクトの進捗・成果物・モックの閲覧とコメントができる"
        "クライアントポータルへの招待が届いています。</p>"
        f'<p><a href="{safe_link}">こちらのリンク</a>からサインインしてください。</p>'
        f"<p>リンクが開けない場合は次の URL をブラウザに貼り付けてください:<br>{safe_link}</p>"
        "<p>※ このリンクには有効期限があります。閲覧 + コメントのみ可能で、編集はできません。</p>"
    )
    body_text = (
        f"{client_display_name or 'ご担当者'} 様\n\n"
        "クライアントポータルへの招待が届いています。\n"
        f"次の URL からサインインしてください:\n{link}\n\n"
        "※ このリンクには有効期限があります。閲覧 + コメントのみ可能です。"
    )
    await ResendSender().send(
        EmailMessage(
            to=(email,),
            subject="【Atelier】プロジェクトへの招待",
            html=body_html,
            text=body_text,
            tags=(("kind", "client_invitation"),),
        )
    )


_COLS = (
    "id, project_id, email, scopes, expires_at, used_at, revoked_at, "
    "client_display_name, use_count, created_at, updated_at"
)


def _scopes(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        loaded: object = json.loads(value)
        if isinstance(loaded, list):
            return [str(x) for x in cast("list[object]", loaded)]
        return []
    if isinstance(value, list):
        return [str(x) for x in cast("list[object]", value)]
    return []


def _row_to_response(row: Any) -> InvitationResponse:
    return InvitationResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        email=str(row.email),
        scopes=_scopes(row.scopes),
        expires_at=row.expires_at,
        used_at=row.used_at,
        revoked_at=row.revoked_at,
        client_display_name=(
            None if row.client_display_name is None else str(row.client_display_name)
        ),
        use_count=int(row.use_count),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_invitations(
    session: AsyncSession, *, project_id: str | None = None
) -> list[InvitationResponse]:
    where = ["1=1"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    res = await session.execute(
        text(
            f"select {_COLS} from public.client_invitations "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_invitation(session: AsyncSession, invitation_id: str) -> InvitationResponse | None:
    res = await session.execute(
        text(f"select {_COLS} from public.client_invitations where id = cast(:id as uuid)"),
        {"id": invitation_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_invitation(
    session: AsyncSession, *, actor_id: str, data: InvitationCreate
) -> InvitationCreateResponse:
    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.client_invitations "
            "(id, project_id, email, token_hash, scopes, expires_at, client_display_name) "
            "values (cast(:id as uuid), cast(:pid as uuid), :email, :th, "
            "        cast(:scopes as jsonb), now() + make_interval(days => :ttl), :cdn)"
        ),
        {
            "id": new_id,
            "pid": data.project_id,
            "email": data.email,
            "th": token_hash,
            "scopes": json.dumps(data.scopes),
            "ttl": data.ttl_days,
            "cdn": data.client_display_name,
        },
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="client_invitation.create",
            target_type="client_invitation",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"email": data.email, "project_id": data.project_id},
        )
    )
    created = await get_invitation(session, new_id)
    if created is None:  # pragma: no cover
        raise RuntimeError("created invitation not visible after insert")

    # 招待メール送信 (best-effort)。ATELIER_EMAIL_API_KEY 未設定なら dry-run で no-op。
    # 送信失敗は招待作成の成否に影響させない (トークンは応答でも返るため運用者が共有可能)。
    with contextlib.suppress(Exception):
        await _send_invitation_email(
            email=data.email,
            link=_invitation_link(raw_token),
            client_display_name=data.client_display_name,
        )

    return InvitationCreateResponse(**created.model_dump(), token=raw_token)


class ResendError(Exception):
    """再送不可の理由 (code: not_found / not_pending)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def resend_invitation(
    session: AsyncSession, *, actor_id: str, invitation_id: str
) -> InvitationCreateResponse:
    """招待メール再送 (GAP-027)。

    token は hash しか保存していないため「元リンクの再送」は不可能。
    再送 = 新 token へローテーション (旧リンク失効) + 新リンクをメール送信。
    未失効・未期限切れの招待が対象 (GAP-264: 使用済みでも再送できる — クライアントが
    リンクを失くして再サインインしたい場面が通し J20-05 で出た。旧リンクは失効し、
    発行済みの client JWT はそのまま有効期限まで使える)。期限切れ/失効は既存の再発行 (新規 POST) を使う。
    """
    cur = await session.execute(
        text(
            "select email, client_display_name, used_at, revoked_at, expires_at "
            "from public.client_invitations where id = cast(:id as uuid)"
        ),
        {"id": invitation_id},
    )
    row = cur.first()
    if row is None:
        raise ResendError("not_found", "invitation not found")
    if row.revoked_at is not None:
        raise ResendError("not_pending", "invitation already revoked")
    if row.expires_at is not None and row.expires_at < datetime.now(UTC):
        raise ResendError("not_pending", "invitation expired — create a new one")

    raw_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
    await session.execute(
        text("update public.client_invitations set token_hash = :th where id = cast(:id as uuid)"),
        {"id": invitation_id, "th": token_hash},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="client_invitation.resend",
            target_type="client_invitation",
            actor_type="user",
            actor_id=actor_id,
            target_id=invitation_id,
            after={"email": str(row.email), "token_rotated": True},
        )
    )
    updated = await get_invitation(session, invitation_id)
    if updated is None:  # pragma: no cover
        raise RuntimeError("invitation not visible after resend")

    # 新リンクをメール送信 (best-effort、作成時と同じ dry-run 挙動)。
    with contextlib.suppress(Exception):
        await _send_invitation_email(
            email=str(row.email),
            link=_invitation_link(raw_token),
            client_display_name=(
                None if row.client_display_name is None else str(row.client_display_name)
            ),
        )

    return InvitationCreateResponse(**updated.model_dump(), token=raw_token)


async def revoke_invitation(
    session: AsyncSession, *, actor_id: str, invitation_id: str
) -> InvitationResponse | None:
    res = await session.execute(
        text(
            "update public.client_invitations set revoked_at = now() "
            "where id = cast(:id as uuid) and revoked_at is null returning id"
        ),
        {"id": invitation_id},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="client_invitation.revoke",
            target_type="client_invitation",
            actor_type="user",
            actor_id=actor_id,
            target_id=invitation_id,
        )
    )
    return await get_invitation(session, invitation_id)
