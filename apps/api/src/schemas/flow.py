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


class DeliveryPhaseResponse(BaseModel):
    """GAP-152: 納品単位のフェーズ (フェーズ1..N)。frozen = 確定済み (成果物凍結)。"""

    id: str
    project_id: str
    seq: int
    name: str
    status: Literal["active", "frozen"]
    note: str | None = None
    frozen_at: datetime | None = None
    # フェーズ別の実数 (UI のフェーズバー/切替に使う)
    mock_count: int = 0
    output_count: int = 0
    task_count: int = 0
    stages_done: int = 0
    stages_total: int = 0


class PhaseFreezeRequest(BaseModel):
    """フェーズ確定は confirm=true (明示承認) 必須 — 成果物が凍結されるため。"""

    confirm: bool = False
    # GAP-280 (通し J30-10): 未完了の工程・タスク・未解決コメントが残っている間は
    # 確定できない。残件を確認した上でどうしても確定するときだけ true を送る。
    acknowledge_open_items: bool = False
    note: str | None = Field(default=None, max_length=500)


class FlowSkipRequest(BaseModel):
    """スキップは理由必須 (黙って消さない)。"""

    reason: str = Field(min_length=1, max_length=500)


class FlowCompleteRequest(BaseModel):
    """hard_gate 工程は confirm=true (ユーザーの明示承認) が必須。"""

    confirm: bool = False


class FreezeCheckResponse(BaseModel):
    """GAP-165: 「今このフェーズを確定していいか」の判断材料 (判定は人が行う)。"""

    phase_id: str
    phase_name: str
    pending_stages: list[str]
    open_tasks: int
    unresolved_comments: int
    output_count: int
    mock_count: int
    warnings: list[str]
