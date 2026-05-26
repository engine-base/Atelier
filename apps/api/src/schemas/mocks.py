"""Mock API スキーマ (T-A-33)。

07_api_design/openapi.yaml#components/schemas/Mock に対応。
E-015 mocks (project_scoped)。version + parent_mock_id でバージョンチェーンを構成。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class MockCreate(BaseModel):
    project_id: str
    screen_name: str = Field(min_length=1, max_length=200)
    html_storage_path: str = Field(min_length=1)
    meta_tags: dict[str, object] | None = None


class MockUpdate(BaseModel):
    html_storage_path: str | None = Field(default=None, min_length=1)
    meta_tags: dict[str, object] | None = None


class MockVersionCreate(BaseModel):
    """既存モックの新バージョン (parent_mock_id で連結、version+1)。"""

    html_storage_path: str = Field(min_length=1)
    meta_tags: dict[str, object] | None = None


class MockResponse(BaseModel):
    id: str
    project_id: str
    screen_name: str
    html_storage_path: str
    version: int
    parent_mock_id: str | None
    meta_tags: dict[str, object] | None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
