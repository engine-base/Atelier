"""成果物 (workflow_outputs) API スキーマ (T-A-21)。

E-006 workflow_outputs (project_scoped)。各工程の生成物。read 中心 (一覧・取得)。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class OutputResponse(BaseModel):
    id: str
    project_id: str
    phase_id: str | None
    stage: str
    html_path: str | None
    json_path: str | None
    md_path: str | None
    summary: str | None
    version: int
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime
