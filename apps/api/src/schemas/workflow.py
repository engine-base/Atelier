"""工程ワークフロー (phases) API スキーマ (T-A-20)。

E-005 phases (project_scoped)。工程の一覧・作成・遷移 (status)。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

PhaseStatus = Literal["pending", "in_progress", "completed", "skipped"]


class PhaseCreate(BaseModel):
    project_id: str
    order: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None


class PhaseSeedRequest(BaseModel):
    project_id: str


class PhaseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    status: PhaseStatus | None = None
    # GAP-004: 担当 AI 社員の割当 (ai_employees.id 群、丸ごと置換)
    assigned_employee_ids: list[str] | None = None


class PhaseResponse(BaseModel):
    id: str
    project_id: str
    order: int
    name: str
    description: str | None
    status: PhaseStatus
    # GAP-004: 担当 AI 社員 (S-F01 ヘッダーアバター / S-F02 割当 UI)
    assigned_employee_ids: list[str]
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime


# --------------------------------------------------------------------------- #
# GAP-022: AI 提案フェーズ (phase_proposals) + F-IMP01 影響範囲解析
# --------------------------------------------------------------------------- #
class PhaseProposalCreate(BaseModel):
    """COO AI (ジャービス) に次フェーズの提案を依頼する (人間の明示操作起点)。"""

    project_id: str


class PhaseProposalResponse(BaseModel):
    id: str
    project_id: str
    name: str
    description: str | None
    reason: str
    """提案理由 (モックの「提案理由を見る」の実体)。"""

    proposed_order: int
    proposed_by: str
    status: str
    """pending / approved / rejected"""

    approved_phase_id: str | None
    created_at: datetime
    resolved_at: datetime | None


class PhaseProposalApproveResponse(BaseModel):
    """承認結果 — 確定した実フェーズ行を返す。"""

    proposal: PhaseProposalResponse
    phase: PhaseResponse


class ImpactAnalysisRequest(BaseModel):
    """F-IMP01: タスクを別フェーズへ移動した場合の影響範囲解析。"""

    task_id: str
    target_phase_id: str


class ImpactAffectedTask(BaseModel):
    id: str
    title: str
    lifecycle_stage: str


class ImpactAnalysisResponse(BaseModel):
    """依存グラフ (tasks.dependencies) の推移的走査結果。推測は含まない。"""

    id: str
    task_id: str
    task_title: str
    target_phase_id: str
    target_phase_name: str
    affected: list[ImpactAffectedTask]
    done_count: int
    """影響先のうち完了済 (lifecycle done) — apply でリファクタ自動起票の対象。"""

    applied: bool


class ImpactApplyResponse(BaseModel):
    """apply 結果 — 実移動 + 自動起票されたリファクタタスク (F-CUC02)。"""

    task_id: str
    moved_to_phase_id: str
    refactor_task_ids: list[str]


class PhaseTaskStatsResponse(BaseModel):
    """phase 別タスク集計 (モックの phase-tasks 行の実体)。"""

    phase_id: str
    total: int
    done: int
    awaiting: int
    avg_score: float | None
    """taskの完了実行スコア平均 (実 task_executions。無ければ null)。"""


class ConsistencyCheckResponse(BaseModel):
    """依存整合性チェック — dependencies が実在タスクを指しているかの実計算。"""

    ok: bool
    dangling_count: int
