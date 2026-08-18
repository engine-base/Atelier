"""Hermes 互換 kanban_tools API スキーマ (T-A-28)。

Bridge worker (F-BRIDGE01) が PTY 内 Claude Code から HTTP で呼び出す
7 つの kanban ツールの request/response 型。Bridge token (X-Bridge-Token)
で認証する別系統 (RLS バイパス、service_role 相当)。

E-012 tasks の lifecycle_stage / dispatch_status / retry_count と
E-013 task_executions の status / score / pass_rate を更新する。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class KanbanPickRequest(BaseModel):
    """次に処理可能な task を 1 件確保 (queued→spawning)。

    project_id を指定するとその project の queued task のみを対象に
    並列上限内で取得する。
    """

    project_id: str | None = None
    worker_pid: int = Field(ge=1)


class KanbanPickResponse(BaseModel):
    task_id: str | None = None
    execution_id: str | None = None
    worktree_path: str | None = None
    no_available_task: bool = False
    # GAP-030: Bridge が子プロセスへ渡すプロンプト材料 (タスク内容)。
    # ID だけでは子 Claude が仕様を探して長考しタイムアウトするため、
    # pick 応答でタスクの中身を返す。
    task_title: str | None = None
    task_description: str | None = None
    assigned_employee: str | None = None


class KanbanStartRequest(BaseModel):
    """worker が実行を開始した通知 (spawning→running)。"""

    task_id: str
    execution_id: str
    worker_pid: int = Field(ge=1)
    claude_code_session_id: str | None = Field(default=None, max_length=200)


class ExecutionTestResultIn(BaseModel):
    """テストケース単位の結果 1 件 (GAP-025② — Bridge complete が記録)。"""

    name: str = Field(min_length=1, max_length=300)
    file: str | None = Field(default=None, max_length=300)
    status: Literal["pass", "fail", "skip"]
    duration_ms: int | None = Field(default=None, ge=0)
    detail: str | None = Field(default=None, max_length=2000)


class KanbanCompleteMetadata(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    ac_pass_rate: float = Field(ge=0.0, le=1.0)
    test_pass_rate: float = Field(ge=0.0, le=1.0)
    verification_score: float = Field(ge=0.0, le=1.0)
    retry_count: int = Field(default=0, ge=0, le=3)
    files_changed: list[str] = Field(default_factory=list, max_length=500)
    # GAP-025②: テストケース単位の結果 (task_execution_tests へ永続)
    tests: list[ExecutionTestResultIn] = Field(
        default_factory=lambda: list[ExecutionTestResultIn](), max_length=200
    )


class KanbanCompleteRequest(BaseModel):
    """task 完了 (running→awaiting or done)。

    auto_approve=True かつ score 閾値超なら done、それ以外は awaiting (人レビュー待ち)。
    """

    task_id: str
    execution_id: str
    summary: str = Field(min_length=1, max_length=4000)
    metadata: KanbanCompleteMetadata
    auto_approve: bool = False


class KanbanRequestReviewRequest(BaseModel):
    """人間レビュー要求 (running→awaiting)。"""

    task_id: str
    execution_id: str
    note: str | None = Field(default=None, max_length=2000)


class KanbanRequestChangeRequest(BaseModel):
    """要求差戻 (running→blocked, blocked_reason に理由)。"""

    task_id: str
    execution_id: str
    reason: str = Field(min_length=1, max_length=2000)


class KanbanHeartbeatRequest(BaseModel):
    """worker heartbeat (PID 生存通知 / dead-man switch)。"""

    task_id: str
    worker_pid: int = Field(ge=1)


class KanbanKillRequest(BaseModel):
    """worker を強制終了 (running→reclaimed, execution→cancelled)。"""

    task_id: str
    execution_id: str | None = None
    reason: str = Field(min_length=1, max_length=2000)


class KanbanResponse(BaseModel):
    """汎用応答。dispatch_status / lifecycle_stage 等を返す。"""

    task_id: str
    lifecycle_stage: str
    dispatch_status: str | None
    execution_status: str | None = None
    action: Literal[
        "picked",
        "started",
        "completed",
        "review_requested",
        "change_requested",
        "heartbeat_ack",
        "killed",
    ]


# ── GAP-114: チャットのローカル実行リレー ────────────────────────


class ChatRelayPickRequest(BaseModel):
    """queued なチャット中継ジョブを 1 件確保 (queued→running)。"""

    worker_id: str = Field(min_length=1, max_length=200)


class ChatRelayPickResponse(BaseModel):
    job_id: str | None = None
    system_prompt: str | None = None
    prompt: str | None = None
    # GAP-134: PC 操作モード (off/approve/auto) — Bridge が本人 PC で実行する
    tools_mode: str | None = None
    no_available_job: bool = False


class ChatRelayChunksRequest(BaseModel):
    """running ジョブへ chunk を追記 (seq_start からの連番)。

    GAP-134: kinds (texts と同長) で種別指定可 — delta (本文) / tool (実況)。
    省略時は全て delta (後方互換)。
    """

    seq_start: int = Field(ge=0)
    texts: list[str] = Field(min_length=1, max_length=200)
    kinds: list[Literal["delta", "tool"]] | None = Field(default=None, max_length=200)


class ChatRelayApprovalCreateRequest(BaseModel):
    """GAP-134: Bridge が CLI の許可要求を承認キューへ積む。"""

    tool: str = Field(min_length=1, max_length=60)
    summary: str = Field(max_length=500)


class ChatRelayApprovalCreateResponse(BaseModel):
    approval_id: str


class ChatRelayApprovalStatusResponse(BaseModel):
    """GAP-134: Bridge がポーリングする決定。"""

    decision: Literal["pending", "allow", "deny", "timeout"]


class ChatRelayArtifactItem(BaseModel):
    """GAP-137/145: PC 操作で生まれた成果物 1 件。

    HTML は html、バイナリ (画像/PPTX/PDF/Excel/動画 等) は content_b64 で
    どちらか一方を送る。MIME はサーバが拡張子から導出する (送信値を信用しない)。
    """

    file_name: str = Field(min_length=1, max_length=200)
    html: str | None = Field(default=None, min_length=1, max_length=512 * 1024)
    # 8MB バイナリの base64 (約 4/3 倍) + 余裕
    content_b64: str | None = Field(default=None, min_length=1, max_length=11 * 1024 * 1024)

    @model_validator(mode="after")
    def _exactly_one_body(self) -> ChatRelayArtifactItem:
        if (self.html is None) == (self.content_b64 is None):
            raise ValueError("exactly one of html / content_b64 is required")
        return self


class ChatRelayArtifactsRequest(BaseModel):
    """GAP-137: 成果物一括送信 (complete 前に呼ぶ — SSE が同一ストリームで配る)。"""

    artifacts: list[ChatRelayArtifactItem] = Field(min_length=1, max_length=10)


class ChatRelayArtifactResult(BaseModel):
    """GAP-137/139: 取り込み結果。

    type="mock" は mocks 行 (mock_id/screen_name)、type="output" は
    workflow_outputs 行 (output_id/stage/title — 見積・提案書等)。
    """

    type: Literal["mock", "output", "file"] = "mock"
    version: int
    mock_id: str | None = None
    screen_name: str | None = None
    output_id: str | None = None
    stage: str | None = None
    title: str | None = None
    # GAP-145: type="file" のみ — image/pdf/slides/sheet/doc/video
    file_kind: str | None = None


class ChatRelayRateLimitObservation(BaseModel):
    """GAP-119: claude CLI の rate_limit_event 観測値 1 件 (実値のみ転送)。"""

    status: Literal["allowed", "allowed_warning", "rejected"]
    rate_limit_type: str | None = Field(default=None, max_length=40)
    utilization: float | None = Field(default=None, ge=0, le=2)
    resets_at: float | None = Field(default=None, gt=0)


class ChatRelayCompleteRequest(BaseModel):
    """running ジョブを done / error で確定する。"""

    ok: bool
    error: str | None = Field(default=None, max_length=2000)
    # GAP-119: 実行中に観測した本人プラン枠 (rate_limit_event)。未観測なら省略
    rate_limits: list[ChatRelayRateLimitObservation] | None = Field(default=None, max_length=20)
