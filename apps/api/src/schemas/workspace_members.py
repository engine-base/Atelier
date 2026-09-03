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


class WorkspaceInvitationResponse(BaseModel):
    """GAP-315: 未登録の宛先への招待リンク (既定 7 日)。

    トークンそのものは返さない (メールで本人にだけ届く)。画面が必要とするのは
    「誰宛に・どの役割で・いつまで」だけ。
    """

    id: str
    workspace_id: str
    workspace_name: str
    email: str
    role: MemberRole
    expires_at: datetime
    invited_by_name: str | None = None


class InvitationPreviewResponse(BaseModel):
    """招待リンクを開いた人に見せる情報 (未サインインでも見られる)。"""

    workspace_name: str
    email: str
    role: MemberRole
    expires_at: datetime
    invited_by_name: str | None = None


class InvitationAcceptResponse(BaseModel):
    workspace_id: str
    workspace_name: str
    role: MemberRole
