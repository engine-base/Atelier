"""商談ドキュメント API スキーマ (T-A-39 / GAP-018)。

E-006 workflow_outputs を sales stage でフィルタする専用 API。S-N01 で
提案書 / 見積書 / 業務委託契約 / NDA / 請求書 のドラフト管理に使う
(GAP-018 で contract / nda / invoice を workflow_stage_enum に追加済 —
migration t-d-99zl。canonical 9 工程には含めない)。

GAP-018 追加分: AI 生成 (営業 AI トニー + ナレッジ RAG — 生成トレースを
meta に記録) / PDF 出力 / メール送信 + 送信履歴 (sales_doc_sends)。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SalesDocType = Literal["proposal", "estimate", "contract", "nda", "invoice"]


class SalesDocCreate(BaseModel):
    project_id: str
    doc_type: SalesDocType
    summary: str | None = Field(default=None, max_length=4000)
    html_path: str | None = Field(default=None, max_length=500)
    json_path: str | None = Field(default=None, max_length=500)
    md_path: str | None = Field(default=None, max_length=500)


class SalesDocUpdate(BaseModel):
    summary: str | None = Field(default=None, max_length=4000)
    html_path: str | None = Field(default=None, max_length=500)
    json_path: str | None = Field(default=None, max_length=500)
    md_path: str | None = Field(default=None, max_length=500)


class SalesDocResponse(BaseModel):
    id: str
    project_id: str
    phase_id: str | None
    doc_type: SalesDocType
    html_path: str | None
    json_path: str | None
    md_path: str | None
    summary: str | None
    version: int
    # GAP-018: 生成トレース (generated_by=tony / model / inputs / knowledge_refs)
    meta: dict[str, object] = Field(default_factory=lambda: dict[str, object]())
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- #
# GAP-018: AI 生成 (トニー + ナレッジ RAG) / メール送信 + 送信履歴
# --------------------------------------------------------------------------- #
class SalesDocGenerateRequest(BaseModel):
    """営業 AI (トニー) にドラフト生成を依頼する (人間の明示操作起点)。"""

    project_id: str
    doc_type: SalesDocType
    customer: str = Field(min_length=1, max_length=200)
    opportunity: str = Field(min_length=1, max_length=200)
    notes: str = Field(min_length=1, max_length=8000)
    """商談概要・要望メモ (生成の入力)。"""


class SalesDocSendRequest(BaseModel):
    """ドラフトをクライアントへメール送信する。"""

    to_email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    subject: str | None = Field(default=None, max_length=200)
    message: str | None = Field(default=None, max_length=2000)
    """本文冒頭に添える挨拶文 (任意)。"""


class SalesDocSendResponse(BaseModel):
    """送信履歴 1 件 (E sales_doc_sends)。dry_run はメール未設定環境の明示。"""

    id: str
    doc_id: str
    to_email: str
    subject: str
    dry_run: bool
    created_at: datetime
