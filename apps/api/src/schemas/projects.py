"""Project API スキーマ (T-A-10)。

07_api_design/openapi.yaml#components/schemas/Project に対応。
契約の enum 値 (type: self_product/client_project/personal、status: in_progress/...)
は DB enum (project_type_enum: internal_product/client_work/...、
project_status_enum: active/...) と異なるため、service 層でマッピングする。
description は DB に列が無いため settings JSONB に格納。current_phase は phases から導出。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ProjectType = Literal["self_product", "client_project", "personal"]
ProjectStatus = Literal["in_progress", "draft", "paused", "archived"]


class ProjectCreate(BaseModel):
    workspace_id: str
    name: str = Field(min_length=1, max_length=200)
    type: ProjectType
    description: str | None = Field(default=None, max_length=2000)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    status: ProjectStatus | None = None


class ProjectResponse(BaseModel):
    id: str
    workspace_id: str
    name: str
    description: str | None
    type: ProjectType
    status: ProjectStatus
    ai_learning_opt_out: bool
    current_phase: str
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class PaginationMeta(BaseModel):
    next_cursor: str | None
    limit: int
    total_estimate: int
