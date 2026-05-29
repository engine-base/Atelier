"""承認待ちインボックス API スキーマ (T-A-32)。

approval_inbox は本人 (user_id = auth.uid()) のみ可視・編集可能 (RLS)。
5 種統合: type ∈ {task_approval, phase_approval, knowledge_write,
comment_response, scope_change} を一つの inbox に集約。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ApprovalType = Literal[
    "task_approval", "phase_approval", "knowledge_write", "comment_response", "scope_change"
]
ApprovalStatus = Literal["pending", "approved", "rejected"]
ApprovalDecision = Literal["approve", "reject"]


class ApprovalResponse(BaseModel):
    id: str
    user_id: str
    type: str
    target_type: str
    target_id: str
    title: str
    payload: dict[str, object]
    status: str
    resolved_at: datetime | None
    resolution_note: str | None
    created_at: datetime
    updated_at: datetime


class ApprovalDecideRequest(BaseModel):
    decision: ApprovalDecision
    note: str | None = Field(default=None, max_length=2000)
