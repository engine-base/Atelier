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


AcceptanceTier = Literal["structural", "functional", "regression"]


class AcceptanceCriterionInput(BaseModel):
    """作成時に添える受入条件 1 行 (GAP-303)。

    tier は 3-tier AC (structural / functional / regression)。既定は functional
    (「何ができれば完成か」= 経営者が書きやすい層)。
    """

    text: str = Field(min_length=1, max_length=500)
    tier: AcceptanceTier = "functional"


class TaskCreate(BaseModel):
    project_id: str
    category: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    type: TaskType
    estimated_hours: int = Field(ge=1, le=24)
    description: str | None = None
    priority: TaskPriority = "medium"
    # GAP-140: 画面タスクは分解時に対象画面を宣言する。同名モックチェーンの
    # 最新に紐づけ、無ければプレースホルダーモック v1 を自動作成して紐づける。
    screen_name: str | None = Field(default=None, min_length=1, max_length=80)
    # GAP-303: 分解の時点で「先に終わっていないと着手できないタスク」と
    # 「何を満たせば完成か」を宣言する。後付けにすると依存が空のまま並列起動され、
    # 受入条件のないタスクが done になる (S-I01 通しで検出)。
    dependencies: list[str] = Field(default_factory=lambda: list[str](), max_length=50)
    acceptance_criteria: list[AcceptanceCriterionInput] = Field(
        default_factory=lambda: list[AcceptanceCriterionInput](), max_length=50
    )


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    type: TaskType | None = None
    estimated_hours: int | None = Field(default=None, ge=1, le=24)
    priority: TaskPriority | None = None
    lifecycle_stage: TaskLifecycle | None = None
    blocked_reason: str | None = None
    # GAP-025: 検証担当 (AI 社員)。"" で解除
    verifier_employee_id: str | None = None
    # GAP-140: 後付けの画面紐づけ (挙動は TaskCreate.screen_name と同じ)
    screen_name: str | None = Field(default=None, min_length=1, max_length=80)


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
    # 依存関係 (契約 Task.dependencies/prerequisites/blocks — S-I02 依存タブが参照)
    dependencies: list[str]
    prerequisites: list[str]
    blocks: list[str]
    worktree_path: str | None
    worker_pid: int | None
    acceptance_criteria_id: str | None
    # GAP-025: 検証担当 + 変更ファイル (S-I02 メタ行)
    verifier_employee_id: str | None = None
    files_changed: list[str] = Field(default_factory=lambda: list[str]())
    # GAP-140: 紐づく画面モック (プレースホルダー含む)
    mock_id: str | None = None
    mock_screen_name: str | None = None
    # GAP-152: 帰属フェーズ (追加分のタスク・依存を分けて扱う)
    delivery_phase_id: str | None = None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class SpecChangeResponse(BaseModel):
    """仕様変更の検知結果 (GAP-025① — S-I02「あなたへの確認」カード)。

    実体: タスクに紐づくモック (mock_id) と同一画面の新しいバージョンが
    後からアップロードされている状態。推測イベントは生成しない。
    """

    kind: str
    """mock_updated のみ (現状の実検知源)。"""

    mock_id: str
    screen_name: str
    current_version: int
    latest_version: int
    latest_mock_id: str
    detected_at: datetime
    """最新モックの作成時刻 (= 変更が発生した実時刻)。"""


class SpecChangeResolveRequest(BaseModel):
    """3 択の取り込み方 (GAP-025①)。

    adopt:   最新仕様で実装し直す (mock_id を最新へ差替)
    split:   現状の実装で完了にする (追加対応を別タスク起票)
    discard: 破棄して分解からやり直す (blocked + dispatch 解除)
    """

    choice: Literal["adopt", "split", "discard"]
    latest_mock_id: str


class SpecChangeResolveResponse(BaseModel):
    choice: str
    note: str
    follow_up_task_id: str | None = None


class RelatedResourceResponse(BaseModel):
    """関連資料 1 件 (GAP-025③ — 実リンクのみ。存在しない資料は返さない)。"""

    kind: str
    """mock / spec / acceptance_criteria / branch / knowledge"""

    name: str
    meta: str
    href: str | None = None


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
    duration_seconds: float | None = None
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


# --------------------------------------------------------------------------- #
# T-A-24: タスク再生 (dispatcher 連動)
# --------------------------------------------------------------------------- #
class PlayTaskRequest(BaseModel):
    """タスク再生リクエスト。force=True で依存未完でも強制起動。"""

    force: bool = False


class PlayTaskResponse(BaseModel):
    """dispatcher 起動結果 (202 Accepted)。

    task は lifecycle_stage=in_progress + dispatch_status=queued / spawning に
    遷移し、E-013 task_executions に新規実行行 (status=running) が作成される。
    実 Bridge worker spawn は F-BRIDGE01 ジョブが ingest する。並列上限超過時は
    queue_position に位置を返す。
    """

    task_id: str
    lifecycle_stage: str
    dispatch_status: str
    execution_id: str
    worktree_path: str | None = None
    bridge_command: str | None = None
    queue_position: int | None = None
