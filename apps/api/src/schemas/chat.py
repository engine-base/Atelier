"""Chat スレッド API スキーマ (T-A-16)。

E-010 chat_threads (project_scoped)。project × AI 社員ごとのスレッド。
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
