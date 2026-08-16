"""Workspace API スキーマ (T-A-06 / GAP-021 icon)。

07_api_design/openapi.yaml#components/schemas/Workspace に対応。
DB (E-002 workspaces) に description 列は無いため settings JSONB に格納し、
member_count / project_count は関連テーブルから集計して返す。

GAP-021: icon (絵文字または 1〜3 文字) を PATCH で更新可能にする。
最大 8 バイト (UTF-8) 超過・制御文字は 422。空文字は「クリア (null に戻す)」。
"""

from __future__ import annotations

import unicodedata
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

# DB 制約 workspaces_name_length = 2..50 文字に合わせる (clean 422 のため)
_NAME = Field(min_length=2, max_length=50)

# DB 制約 workspaces_icon_length (octet_length 1..8) に合わせる
ICON_MAX_BYTES = 8


def validate_icon(value: str | None) -> str | None:
    """icon の検証: 空文字 → None (クリア)。8 バイト超過 / 制御文字は ValueError (422)。"""
    if value is None:
        return None
    if value == "":
        return None
    if any(unicodedata.category(ch) == "Cc" for ch in value):
        raise ValueError("icon must not contain control characters")
    if len(value.encode("utf-8")) > ICON_MAX_BYTES:
        raise ValueError(f"icon must be at most {ICON_MAX_BYTES} bytes (絵文字または 1〜3 文字)")
    return value


class WorkspaceCreate(BaseModel):
    name: str = _NAME
    description: str | None = Field(default=None, max_length=2000)


class WorkspaceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=50)
    description: str | None = Field(default=None, max_length=2000)
    # 明示的に icon を送った時のみ更新 (model_fields_set で判定)。"" / null はクリア
    icon: str | None = None

    @field_validator("icon")
    @classmethod
    def _icon(cls, v: str | None) -> str | None:
        return validate_icon(v)


class WorkspaceResponse(BaseModel):
    id: str
    name: str
    description: str | None
    icon: str | None
    member_count: int
    project_count: int
    plan: str
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
