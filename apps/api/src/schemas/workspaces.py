"""Workspace API スキーマ (T-A-06)。

07_api_design/openapi.yaml#components/schemas/Workspace に対応。
DB (E-002 workspaces) に description 列は無いため settings JSONB に格納し、
member_count / project_count は関連テーブルから集計して返す。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

# DB 制約 workspaces_name_length = 2..50 文字に合わせる (clean 422 のため)
_NAME = Field(min_length=2, max_length=50)


class WorkspaceCreate(BaseModel):
    name: str = _NAME
    description: str | None = Field(default=None, max_length=2000)


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=50)
    description: str | None = Field(default=None, max_length=2000)


class WorkspaceResponse(BaseModel):
    id: str
    name: str
    description: str | None
    member_count: int
    project_count: int
    plan: str
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
