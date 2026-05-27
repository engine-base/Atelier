"""公開ページ API スキーマ (T-A-44)。

F-LEGAL-001 法令ページ (E-026 legal_documents) / F-LEGAL-002 データ削除請求。
法令ページは未認証 (anon) で閲覧可能。データ削除請求は本人 (authenticated) のみ。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

LegalDocType = Literal["terms_of_service", "privacy_policy", "tokushoho"]


class LegalDocumentResponse(BaseModel):
    id: str
    doc_type: str
    version: str
    locale: str
    title: str
    body_md: str
    effective_date: date
    is_current: bool
    created_at: datetime
    updated_at: datetime


class DataDeletionRequestCreate(BaseModel):
    reason: str | None = Field(default=None, max_length=2000)


class DataDeletionRequestResponse(BaseModel):
    request_id: str
    status: str
    requested_at: datetime
