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
    #: 書いた人の表示名 (GAP-226)。社内メンバーは表示名、クライアントは招待の表示名。
    #:
    #: これが無かったため、社内の画面は全員を **「クライアント（招待）」**、
    #: 社内メンバーを **「メンバー 8f3bbf48」** (UUID の断片) としか出せなかった。
    #: 1 つの案件に窓口が 2 人いると、**誰が言ったのか区別できない**。
    author_name: str | None = None
    #: クライアントからの書き込みか (社内の書き込みと見分けるため)。
    is_client_author: bool = False
    content: str
    status: str
    parent_comment_id: str | None
    created_at: datetime
    updated_at: datetime


class CommentUnresolvedCountResponse(BaseModel):
    """GAP-005: プロジェクト横断の未解決 (status=open) コメント集計。"""

    project_id: str
    count: int
