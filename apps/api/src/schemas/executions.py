"""実行モニター API + Bridge 状態 スキーマ (T-A-30)。

S-I03 実行モニタ画面の信頼源 = E-013 task_executions + tasks.dispatch_status。
read-only API。RLS が cross-workspace 越境を担保 (T-D-16 tasks_select_member
経由で task_executions も scope される)。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ExecutionStatus = Literal["running", "succeeded", "failed", "cancelled", "timeout"]


class ExecutionResponse(BaseModel):
    """task_executions 1 行に対応する詳細レスポンス。

    worker_pid / dispatch_status は join 先 tasks から取得 (実行モニタが
    両者を同時表示するため)。
    """

    id: str
    task_id: str
    task_title: str
    project_id: str
    started_at: datetime
    completed_at: datetime | None
    duration_seconds: float | None
    status: ExecutionStatus
    score: float | None
    ac_pass_rate: float | None
    test_pass_rate: float | None
    verification_score: float | None
    retry_count: int
    claude_code_session_id: str | None
    logs_storage_path: str | None
    error_summary: str | None
    worker_pid: int | None
    dispatch_status: str | None
    created_at: datetime


class BridgeStatusResponse(BaseModel):
    """Bridge worker 集約状態。

    running_count: dispatch_status='running' の task 数
    queued_count: dispatch_status='queued' の task 数
    completing_count: dispatch_status='completing' の task 数
    spawning_count: dispatch_status='spawning' の task 数
    dead_count: dispatch_status='dead' or 'reclaimed' の task 数 (24h)
    parallel_limit: 同時実行上限 (_PARALLEL_LIMIT)
    available_slots: max(0, parallel_limit - running_count)
    oldest_running_started_at: 最古の running task_executions の開始時刻
    active_worker_pids: 現在 running の worker_pid 一覧 (ソート済)
    evaluated_at: 集計時刻
    """

    running_count: int = Field(ge=0)
    queued_count: int = Field(ge=0)
    completing_count: int = Field(ge=0)
    spawning_count: int = Field(ge=0)
    dead_count_24h: int = Field(ge=0)
    parallel_limit: int = Field(ge=1)
    available_slots: int = Field(ge=0)
    oldest_running_started_at: datetime | None
    active_worker_pids: list[int]
    evaluated_at: datetime
