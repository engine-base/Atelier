"""GAP-122: Bridge 接続トークンのスキーマ。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class BridgeTokenCreate(BaseModel):
    """発行リクエスト (label は端末名など任意)。"""

    label: str | None = Field(default=None, max_length=100)


class BridgeTokenCreated(BaseModel):
    """発行応答 — token (raw) はこの応答で 1 度だけ返す。"""

    id: str
    token: str
    label: str
    created_at: datetime


class BridgeTokenRow(BaseModel):
    """一覧行 (raw / hash は含めない)。"""

    id: str
    label: str
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None
