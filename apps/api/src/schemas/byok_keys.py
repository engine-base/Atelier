"""BYOK API キー管理スキーマ (T-A-09)。

byok_api_keys は本人 (user_id = auth.uid()) のみ可視・編集可能 (RLS)。
provider ∈ {claude, openai, gemini}。
encrypted_key は Fernet (対称暗号、ATELIER_BYOK_ENCRYPTION_KEY env から鍵生成) で
保存し、API 応答には plaintext を **一切返さない** (mcp_tokens は作成時 1 度だけ
返したが、BYOK はユーザが既に保有する key を預ける形なので開示不要)。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

BYOKProvider = Literal["claude", "openai", "gemini"]


class ByokKeyCreate(BaseModel):
    provider: BYOKProvider
    key: str = Field(min_length=1, max_length=10000)  # plaintext (保存時に暗号化)
    label: str | None = Field(default=None, min_length=1, max_length=100)


class ByokKeyUpdate(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=100)
    is_active: bool | None = None


class ByokKeyResponse(BaseModel):
    """plaintext / encrypted_key を含まない応答 (機密保持)。"""

    id: str
    user_id: str
    provider: str
    label: str | None
    is_active: bool
    created_at: datetime
    updated_at: datetime
