"""商談ドキュメント (提案・見積) API スキーマ (T-A-39)。

E-006 workflow_outputs を sales stage (proposal / estimate) でフィルタする
専用 API。S-N01 で 提案書 / 見積書 のドラフト管理に使う。

契約 (contract) と請求書 (invoice) は workflow_stage_enum に未追加のため
本 T-A-39 では対象外（将来拡張）。stage は proposal / estimate のみ。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SalesDocType = Literal["proposal", "estimate"]


class SalesDocCreate(BaseModel):
    project_id: str
    doc_type: SalesDocType
    summary: str | None = Field(default=None, max_length=4000)
    html_path: str | None = Field(default=None, max_length=500)
    json_path: str | None = Field(default=None, max_length=500)
    md_path: str | None = Field(default=None, max_length=500)


class SalesDocUpdate(BaseModel):
    summary: str | None = Field(default=None, max_length=4000)
    html_path: str | None = Field(default=None, max_length=500)
    json_path: str | None = Field(default=None, max_length=500)
    md_path: str | None = Field(default=None, max_length=500)


class SalesDocResponse(BaseModel):
    id: str
    project_id: str
    phase_id: str | None
    doc_type: SalesDocType
    html_path: str | None
    json_path: str | None
    md_path: str | None
    summary: str | None
    version: int
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
