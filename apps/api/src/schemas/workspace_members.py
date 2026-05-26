"""WS メンバー API スキーマ (T-A-07)。

E-003 workspace_memberships。招待 (email+role)・ロール変更・削除。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

MemberRole = Literal["owner", "member", "viewer"]


class MemberInvite(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    role: MemberRole
    message: str | None = Field(default=None, max_length=500)


class MemberRoleUpdate(BaseModel):
    role: MemberRole


class MemberResponse(BaseModel):
    workspace_id: str
    user_id: str
    email: str
    display_name: str | None
    role: MemberRole
    joined_at: datetime
