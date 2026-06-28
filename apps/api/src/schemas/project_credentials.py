"""プロジェクト金庫スキーマ (T-A-46)。

project_credentials は project の workspace member のみ可視・編集可能 (RLS)。
plaintext は Fernet で暗号化して encrypted_value に保存し、API 応答には
**一切含めない** (reveal endpoint でのみ復号して返す)。

kind ∈ {api_key, password, token, connection_string, other}。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

CredentialKind = Literal["api_key", "password", "token", "connection_string", "other"]


class CredentialCreate(BaseModel):
    """金庫への登録。value は plaintext (保存時に暗号化)。"""

    name: str = Field(min_length=1, max_length=200)
    kind: CredentialKind = "other"
    value: str = Field(min_length=1, max_length=10000)  # plaintext


class CredentialUpdate(BaseModel):
    """name / kind の更新 (value は変更しない)。"""

    name: str | None = Field(default=None, min_length=1, max_length=200)
    kind: CredentialKind | None = None


class CredentialResponse(BaseModel):
    """一覧/詳細応答。plaintext / encrypted_value を含まない (機密保持)。"""

    id: str
    project_id: str
    name: str
    kind: str
    last4: str | None
    created_at: datetime
    updated_at: datetime


class CredentialReveal(BaseModel):
    """reveal 応答。権限者のみ・監査記録済の上で plaintext を 1 度返す。"""

    id: str
    name: str
    value: str  # plaintext (復号済)
