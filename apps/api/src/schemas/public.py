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


class BridgeLatestResponse(BaseModel):
    """GAP-135: Bridge 更新チェック用の最新版情報。

    download_urls は OS キー (mac/win/linux) → installer URL。未設定の OS は
    省略される (Bridge 側はバナーの案内文のみ表示)。
    """

    version: str
    download_urls: dict[str, str] = Field(default_factory=dict)


class ConsentStatusResponse(BaseModel):
    """GAP-206: 同意状況 1 件（同意し直しが要るかどうか）。"""

    doc_type: str
    #: 今 有効な版
    current_version: str | None
    #: この人が最後に同意した版（未同意なら null）
    accepted_version: str | None
    #: 同意し直しが要るか
    needs_consent: bool


class ConsentStatusListResponse(BaseModel):
    """GAP-206: 同意状況の一覧と、まとめの判定。"""

    items: list[ConsentStatusResponse]
    #: 1 件でも同意し直しが要るか（画面はこれで案内を出す）
    needs_consent: bool


class ConsentAcceptRequest(BaseModel):
    """GAP-206: 同意の記録。

    **版を必ず指定させる** — 画面が見せた版と記録する版が食い違うと、
    「読んでいない文面に同意した」ことになるため。
    """

    doc_type: str
    version: str
