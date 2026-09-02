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


class BridgeWorkerInfo(BaseModel):
    """Bridge presence 1 件 (GAP-026① — POST /bridge/ping の upsert 結果)。"""

    id: str
    host_label: str
    version: str
    worker_pid: int | None
    last_seen_at: datetime
    connected: bool
    """last_seen_at が 90 秒以内 (poll 間隔 ×3 相当)。"""


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
    # GAP-026: 一時停止フラグ + Bridge presence (直近 5 分に ping した worker)
    paused: bool = False
    workers: list[BridgeWorkerInfo] = Field(default_factory=lambda: list[BridgeWorkerInfo]())


class BridgePingRequest(BaseModel):
    """Bridge presence 登録 (BridgeAuth)。poll ごとに送られる。"""

    worker_id: str = Field(min_length=1, max_length=200)
    host_label: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=50)
    worker_pid: int | None = None


class BridgeByeRequest(BaseModel):
    """GAP-243: Bridge 終了時の presence 抹消 (BridgeAuth)。

    presence は 90 秒の鮮度で判定するため、終了を伝えないと最長 90 秒は画面が
    「接続中」のままになり、その間の送信は誰にも拾われない。
    """

    worker_id: str = Field(min_length=1, max_length=200)


class DispatchControlResponse(BaseModel):
    """「すべて一時停止」の現在状態 (GAP-026②)。"""

    paused: bool
    paused_at: datetime | None
    paused_by: str | None


class DispatchPromoteResponse(BaseModel):
    """「順番待ちから 1 件追加」の結果 — 昇格された実タスク。"""

    task_id: str
    title: str
    note: str


class ExecutionTestResult(BaseModel):
    """テストケース単位の結果 (GAP-025② — task_execution_tests read)。"""

    id: str
    execution_id: str
    name: str
    file: str | None
    status: str
    duration_ms: int | None
    detail: str | None
    created_at: datetime


class ExecutionEvent(BaseModel):
    """ログ集約ビューの 1 イベント (GAP-026⑤ — 実 task_executions から導出)。"""

    at: datetime
    kind: str
    """started / succeeded / failed / cancelled / timeout"""
    execution_id: str
    task_id: str
    task_title: str
    score: float | None
    error_summary: str | None
