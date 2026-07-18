"""確定事項/未確認 (decisions) API スキーマ (T-D-101)。

S-F01 の確定事項タブ (status=decided) と未確認タブ (status=unresolved)。
project_scoped。工程 (phase_id) に紐づく decision log。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

DecisionStatus = Literal["decided", "unresolved"]


class DecisionCreate(BaseModel):
    project_id: str
    phase_id: str | None = None
    status: DecisionStatus = "decided"
    body: str = Field(min_length=1, max_length=2000)
    reflected_to: str | None = Field(default=None, max_length=500)
    resolve_note: str | None = Field(default=None, max_length=500)
    decided_by: str | None = None
    with_user: bool = False


class DecisionUpdate(BaseModel):
    status: DecisionStatus | None = None
    body: str | None = Field(default=None, min_length=1, max_length=2000)
    reflected_to: str | None = Field(default=None, max_length=500)
    resolve_note: str | None = Field(default=None, max_length=500)


class DecisionResponse(BaseModel):
    id: str
    project_id: str
    phase_id: str | None
    status: DecisionStatus
    body: str
    reflected_to: str | None
    resolve_note: str | None
    decided_by: str | None
    with_user: bool
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None
