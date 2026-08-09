"""運営サポート連絡 API スキーマ (GAP-031⑥ — S-T04)。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class SupportContactRequest(BaseModel):
    """サポートメール送信リクエスト (admin 専用)。"""

    user_id: str
    subject: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=5000)


class SupportContactResponse(BaseModel):
    """送信結果。dry_run=true はメール未設定環境 (実送信なし) の明示。"""

    to_email: str
    dry_run: bool


class SupportContactItem(BaseModel):
    """「最近のサポート対応」1 行 (audit support.contact からの逆引き)。"""

    to_email: str
    display_name: str | None
    subject: str
    created_at: datetime
