"""クライアント招待 API スキーマ (T-A-34)。

E-017 client_invitations。token は生成時のみ raw を返し、DB には SHA-256 hash のみ保存。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class InvitationCreate(BaseModel):
    project_id: str
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    scopes: list[str] = Field(default_factory=lambda: ["view", "comment"])
    client_display_name: str | None = Field(default=None, max_length=100)
    ttl_days: int = Field(default=7, ge=1, le=30)


class InvitationResponse(BaseModel):
    id: str
    project_id: str
    email: str
    scopes: list[str]
    expires_at: datetime
    used_at: datetime | None
    revoked_at: datetime | None
    client_display_name: str | None
    created_at: datetime
    updated_at: datetime


class InvitationCreateResponse(InvitationResponse):
    """作成時のみ raw token を 1 度だけ返す (招待 URL 用、再取得不可)。"""

    token: str
