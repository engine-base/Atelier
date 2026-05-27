"""公開ページ (public) サービス層 (T-A-44)。

法令ページ (legal_documents) は anon ロールの session で公開閲覧する
(RLS: legal_documents_public_read TO anon,authenticated USING true)。
データ削除請求 (F-LEGAL-002) は authenticated session で本人の請求を
audit_logs に記録する (専用テーブルは無いため append-only ログに残す)。
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.public import (
    DataDeletionRequestCreate,
    DataDeletionRequestResponse,
    LegalDocumentResponse,
)

_LEGAL_COLS = (
    "id, doc_type, version, locale, title, body_md, effective_date, "
    "is_current, created_at, updated_at"
)


def _legal_to_response(row: Any) -> LegalDocumentResponse:
    return LegalDocumentResponse(
        id=str(row.id),
        doc_type=str(row.doc_type),
        version=str(row.version),
        locale=str(row.locale),
        title=str(row.title),
        body_md=str(row.body_md),
        effective_date=row.effective_date,
        is_current=bool(row.is_current),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_legal_documents(
    session: AsyncSession, *, locale: str | None = None
) -> list[LegalDocumentResponse]:
    """現行 (is_current) の法令ページ一覧。anon でも閲覧可。"""
    where = ["is_current = true"]
    params: dict[str, object] = {}
    if locale is not None:
        where.append("locale = :loc")
        params["loc"] = locale
    res = await session.execute(
        text(
            f"select {_LEGAL_COLS} from public.legal_documents "
            f"where {' and '.join(where)} order by doc_type"
        ),
        params,
    )
    return [_legal_to_response(r) for r in res.all()]


async def get_legal_document(
    session: AsyncSession, *, doc_type: str, locale: str = "ja"
) -> LegalDocumentResponse | None:
    """doc_type の現行版を取得。無ければ None。"""
    res = await session.execute(
        text(
            f"select {_LEGAL_COLS} from public.legal_documents "
            "where doc_type = :dt and locale = :loc and is_current = true"
        ),
        {"dt": doc_type, "loc": locale},
    )
    row = res.first()
    return None if row is None else _legal_to_response(row)


async def create_data_deletion_request(
    session: AsyncSession, *, actor_id: str, data: DataDeletionRequestCreate
) -> DataDeletionRequestResponse:
    """本人によるデータ削除請求を audit_logs に記録する (F-LEGAL-002)。

    専用テーブルは無いため append-only な audit_logs に actor=user 本人として残す
    (audit_logs_insert_self ポリシーを満たす)。実際の削除実行は退会フロー (T-A-05)
    が 30 日猶予で扱う。
    """
    request_id = str(uuid.uuid4())
    requested_at = datetime.now(tz=UTC)
    await AuditWriter(session).write(
        AuditEvent(
            action="data_deletion.request",
            target_type="data_deletion_request",
            actor_type="user",
            actor_id=actor_id,
            target_id=request_id,
            after={"reason": data.reason},
            created_at=requested_at,
        )
    )
    return DataDeletionRequestResponse(
        request_id=request_id, status="received", requested_at=requested_at
    )
