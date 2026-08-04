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


class PhaseSeedRequest(BaseModel):
    project_id: str


class PhaseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    status: PhaseStatus | None = None
    # GAP-004: 担当 AI 社員の割当 (ai_employees.id 群、丸ごと置換)
    assigned_employee_ids: list[str] | None = None


class PhaseResponse(BaseModel):
    id: str
    project_id: str
    order: int
    name: str
    description: str | None
    status: PhaseStatus
    # GAP-004: 担当 AI 社員 (S-F01 ヘッダーアバター / S-F02 割当 UI)
    assigned_employee_ids: list[str]
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime
