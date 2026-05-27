"""Chat スレッド / メッセージ API スキーマ (T-A-16 / T-A-17)。

E-010 chat_threads (project_scoped)。project × AI 社員ごとのスレッド。
E-011 chat_messages。T-A-17 はユーザー発話の即時送信 + スレッド内一覧 (read)。
AI 応答の生成 (LLM) は SSE ストリーミングの T-A-18 が担う。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


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


class MessageCreate(BaseModel):
    content: str = Field(min_length=1, max_length=100000)


class MessageResponse(BaseModel):
    id: str
    thread_id: str
    role: str
    content: str
    parent_message_id: str | None
    token_count: int | None
    created_at: datetime
    updated_at: datetime
