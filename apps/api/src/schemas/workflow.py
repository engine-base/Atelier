"""工程ワークフロー (phases) API スキーマ (T-A-20)。

E-005 phases (project_scoped)。工程の一覧・作成・遷移 (status)。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

PhaseStatus = Literal["pending", "in_progress", "completed", "skipped"]


class PhaseCreate(BaseModel):
    project_id: str
    order: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None


class PhaseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    status: PhaseStatus | None = None


class PhaseResponse(BaseModel):
    id: str
    project_id: str
    order: int
    name: str
    description: str | None
    status: PhaseStatus
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
