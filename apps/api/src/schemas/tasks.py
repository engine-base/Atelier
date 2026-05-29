"""Task API スキーマ (T-A-26)。

07_api_design/openapi.yaml#components/schemas/Task に対応。
契約 ↔ DB の差異を service 層で吸収する:
  priority : critical↔urgent / high / medium / low
  type     : migration(契約のみ)→infrastructure / それ以外は 1:1
  phase    : 契約は phase 名(str)、DB は phase_id(uuid) → 応答は phases.name を join
  assigned_employee_id : 契約は社員名、DB は ai_employees.id(uuid) → 応答は名前を join
lifecycle_stage / dispatch_status は契約=DB で 1:1。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

TaskType = Literal["foundation", "screen", "feature", "verification", "infrastructure", "migration"]
TaskPriority = Literal["critical", "high", "medium", "low"]
TaskLifecycle = Literal["triage", "ready", "in_progress", "blocked", "awaiting", "done"]


class TaskCreate(BaseModel):
    project_id: str
    category: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    type: TaskType
    estimated_hours: int = Field(ge=1, le=24)
    description: str | None = None
    priority: TaskPriority = "medium"


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    type: TaskType | None = None
    estimated_hours: int | None = Field(default=None, ge=1, le=24)
    priority: TaskPriority | None = None
    lifecycle_stage: TaskLifecycle | None = None
    blocked_reason: str | None = None


class TaskResponse(BaseModel):
    id: str
    project_id: str
    phase: str | None
    category: str
    title: str
    description: str | None
    type: str
    estimated_hours: int
    priority: TaskPriority
    lifecycle_stage: TaskLifecycle
    dispatch_status: str | None
    assigned_employee_id: str | None
    summary: str | None
    metadata: dict[str, object]
    blocked_reason: str | None
    retry_count: int
    worktree_path: str | None
    worker_pid: int | None
    acceptance_criteria_id: str | None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AcceptanceCriteriaResponse(BaseModel):
    id: str
    task_id: str
    html_path: str
    items: list[object]
    version: int
    created_at: datetime
    updated_at: datetime


class TaskExecutionResponse(BaseModel):
    """タスク実行履歴・スコア (E-013 task_executions、T-A-27)。read-only。"""

    id: str
    task_id: str
    started_at: datetime
    completed_at: datetime | None
    score: float | None
    ac_pass_rate: float | None
    test_pass_rate: float | None
    verification_score: float | None
    retry_count: int
    status: str
    claude_code_session_id: str | None
    logs_storage_path: str | None
    error_summary: str | None
    created_at: datetime


# --------------------------------------------------------------------------- #
# T-A-25: タスク一括再生 + 承認/差戻/再試行
# --------------------------------------------------------------------------- #
class TaskBulkLifecycleRequest(BaseModel):
    """複数 task の lifecycle_stage を一括遷移する。

    target_stage は task_lifecycle_enum (triage / ready / in_progress /
    blocked / awaiting / done) のいずれか。空 task_ids は 422 で拒否。
    """

    task_ids: list[str] = Field(min_length=1, max_length=200)
    target_stage: TaskLifecycle
    note: str | None = Field(default=None, max_length=2000)


class TaskBulkLifecycleResponse(BaseModel):
    """個別の遷移結果。updated は実際に状態が変化した task の数。"""

    requested: int
    updated: int
    updated_task_ids: list[str]
    skipped_task_ids: list[str]


class TaskDecisionRequest(BaseModel):
    """承認 / 差戻 / 再試行の追加ノート (任意)。"""

    note: str | None = Field(default=None, max_length=2000)
