"""サーキットブレーカ + PID ポーリング API スキーマ (T-A-29)。

F-DISP01 Dispatcher の信頼性運用。worker_pid + worker_last_heartbeat_at
を監視し、stale (heartbeat 切れ) な task を reclaim する。失敗率閾値で
circuit breaker を open → spawn 抑止。

state は in-memory のではなく DB (tasks.dispatch_status + task_executions)
を信頼源として計算する (re-deploy 耐性、複数 instance 整合性)。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

CircuitState = Literal["closed", "open", "half_open"]


class CircuitBreakerState(BaseModel):
    """worker breaker の現在状態。state は failure 率 + 時間窓で決定。"""

    state: CircuitState
    failure_rate: float = Field(ge=0.0, le=1.0)
    total_executions: int = Field(ge=0)
    failed_executions: int = Field(ge=0)
    window_minutes: int = Field(ge=1, le=60)
    threshold: float = Field(ge=0.0, le=1.0)
    next_retry_at: datetime | None = None
    evaluated_at: datetime


class PidPollRequest(BaseModel):
    """PID ポーリング request。heartbeat_threshold_seconds より古い heartbeat
    を持つ running task を reclaim 対象として走査する。
    """

    heartbeat_threshold_seconds: int = Field(default=60, ge=10, le=600)
    dry_run: bool = False


class PidPollResult(BaseModel):
    """単一の stale task に対する処理結果。"""

    task_id: str
    worker_pid: int | None
    last_heartbeat_at: datetime | None
    action: Literal["reclaimed", "dry_run_would_reclaim"]


class PidPollResponse(BaseModel):
    polled_at: datetime
    threshold_seconds: int
    stale_task_count: int
    results: list[PidPollResult]


class CircuitResetRequest(BaseModel):
    """breaker reset 用。reason は audit に残る。"""

    reason: str = Field(min_length=1, max_length=2000)
