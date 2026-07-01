"""自己プロフィール（/me）スキーマ — T-UC-37。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class MeResponse(BaseModel):
    """認証ユーザー自身のプロフィール。"""

    id: str
    email: str
    display_name: str | None


class MeUpdate(BaseModel):
    """自己プロフィール更新。現状は display_name のみ変更可能。"""

    display_name: str = Field(min_length=1, max_length=100)
