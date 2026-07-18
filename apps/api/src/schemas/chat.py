"""Chat スレッド / メッセージ / 分岐 / feedback API スキーマ (T-A-16 / T-A-17 / T-A-19)。

E-010 chat_threads (project_scoped)。project × AI 社員ごとのスレッド。
E-011 chat_messages。T-A-17 はユーザー発話の即時送信 + スレッド内一覧 (read)。
T-A-19 はスレッド分岐 (parent_message_id) と message feedback (audit_logs 記録)。
AI 応答の生成 (LLM) は SSE ストリーミングの T-A-18 が担う。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

FeedbackValue = Literal["up", "down"]


class ThreadCreate(BaseModel):
    project_id: str
    ai_employee_id: str
    title: str | None = Field(default=None, min_length=1, max_length=200)


class ThreadUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    archived: bool | None = None


class ThreadResponse(BaseModel):
    id: str
    project_id: str
    ai_employee_id: str
    title: str | None
    archived: bool
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # 一覧表示用のメッセージ件数 (S-F01 議論中タブ / S-E01 スレッド一覧)
    message_count: int = 0


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=100000)
    parent_message_id: str | None = None  # T-A-19: 分岐対応 (同スレッド内の親メッセージ)


class MessageResponse(BaseModel):
    id: str
    thread_id: str
    role: str
    content: str
    parent_message_id: str | None
    token_count: int | None
    created_at: datetime
    updated_at: datetime


class MessageFeedbackCreate(BaseModel):
    """T-A-19: メッセージへのフィードバック (up/down + 任意コメント)。

    専用テーブルが無いため append-only な audit_logs に本人の feedback を記録する。
    """

    value: FeedbackValue
    comment: str | None = Field(default=None, max_length=2000)


class MessageFeedbackResponse(BaseModel):
    feedback_id: str
    message_id: str
    value: str
    comment: str | None
    recorded_at: datetime
