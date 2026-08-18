"""GAP-150: プロジェクトフロー API スキーマ。

07_api_design/openapi.yaml#components/schemas/FlowStage に対応。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class FlowStageTemplate(BaseModel):
    """フロー・テンプレートの 1 工程 (コード内定義 — DB には展開して保存)。"""

    stage_key: str
    title: str
    department: str
    skippable: bool = False
    hard_gate: bool = False


class FlowStageResponse(BaseModel):
    id: str
    stage_key: str
    seq: int
    title: str
    department: str
    status: Literal["pending", "done", "skipped"]
    skippable: bool
    hard_gate: bool
    skip_reason: str | None = None
    completed_at: datetime | None = None
    # 導出値: 現在のステージ (最小 seq の pending) か
    current: bool = False
    # 担当社員 (workspace の該当部門から解決)。部門に社員が居なければ null
    employee_id: str | None = None
    employee_name: str | None = None
    employee_icon: str | None = None
    # その社員との既存スレッド (フロー起点タブの遷移先)。無ければ null
    thread_id: str | None = None


class FlowSkipRequest(BaseModel):
    """スキップは理由必須 (黙って消さない)。"""

    reason: str = Field(min_length=1, max_length=500)


class FlowCompleteRequest(BaseModel):
    """hard_gate 工程は confirm=true (ユーザーの明示承認) が必須。"""

    confirm: bool = False
