"""コメント API スキーマ (T-A-22)。

07_api_design/openapi.yaml#components/schemas/Comment。E-016 comments。
成果物 / モック / タスク / 受入条件に対するスレッド型コメント。
可視性・権限は RLS (comments_*_member / comments_client_*) が信頼源。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

CommentTargetType = Literal["workflow_output", "mock", "task", "acceptance_criteria"]
CommentStatus = Literal["open", "resolved"]


class CommentCreate(BaseModel):
    target_type: CommentTargetType
    target_id: str
    content: str = Field(min_length=1, max_length=10000)
    target_element_id: str | None = Field(default=None, max_length=200)
    parent_comment_id: str | None = None


class CommentUpdate(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=10000)
    status: CommentStatus | None = None


class CommentResponse(BaseModel):
    id: str
    target_type: CommentTargetType
    target_id: str
    target_element_id: str | None
    author_user_id: str | None
    author_invitation_id: str | None
    content: str
    status: str
    parent_comment_id: str | None
    created_at: datetime
    updated_at: datetime
