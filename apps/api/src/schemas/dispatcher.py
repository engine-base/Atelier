"""Hermes 互換 kanban_tools API スキーマ (T-A-28)。

Bridge worker (F-BRIDGE01) が PTY 内 Claude Code から HTTP で呼び出す
7 つの kanban ツールの request/response 型。Bridge token (X-Bridge-Token)
で認証する別系統 (RLS バイパス、service_role 相当)。

E-012 tasks の lifecycle_stage / dispatch_status / retry_count と
E-013 task_executions の status / score / pass_rate を更新する。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


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


class KanbanStartRequest(BaseModel):
    """worker が実行を開始した通知 (spawning→running)。"""

    task_id: str
    execution_id: str
    worker_pid: int = Field(ge=1)
    claude_code_session_id: str | None = Field(default=None, max_length=200)


class KanbanCompleteMetadata(BaseModel):
    score: float = Field(ge=0.0, le=1.0)
    ac_pass_rate: float = Field(ge=0.0, le=1.0)
    test_pass_rate: float = Field(ge=0.0, le=1.0)
    verification_score: float = Field(ge=0.0, le=1.0)
    retry_count: int = Field(default=0, ge=0, le=3)
    files_changed: list[str] = Field(default_factory=list, max_length=500)


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
