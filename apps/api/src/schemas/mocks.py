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


class MockReviseRequest(BaseModel):
    """S-H01「編集」= ワンダ (AI デザイナー) への修正指示 (GAP-024)。"""

    instruction: str = Field(min_length=1, max_length=4000)


class DesignNoteUpdate(BaseModel):
    """GAP-143: プロジェクトのデザインノート (DESIGN.md 相当)。"""

    note: str = Field(max_length=2000)


class MockGenerateRequest(BaseModel):
    """GAP-138: S-H01「新規モック」— ワンダによる新規生成。

    screen_name 省略時は生成 HTML の <title> から導出する。
    """

    project_id: str
    instruction: str = Field(min_length=1, max_length=4000)
    screen_name: str | None = Field(default=None, max_length=80)


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
