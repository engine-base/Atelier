"""実行ログ SSE 配信 スキーマ (T-A-31)。

S-I03 実行モニタ画面の「ログをライブで見る」機能。E-013 task_executions
の status / logs_storage_path / error_summary を SSE で polling 配信する。

実 worker stdout の tail は F-BRIDGE01 backend job が logs_storage_path に
flush する前提。本 API は execution の状態遷移 + 保存済ログのメタデータを
配信する責務に限定 (worker process には直接アクセスしない)。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

ExecLogEventType = Literal["snapshot", "status_change", "end", "error"]


class ExecLogMeta(BaseModel):
    """実行ログのメタデータ (non-streaming)。"""

    execution_id: str
    task_id: str
    status: str
    started_at: datetime
    completed_at: datetime | None
    logs_storage_path: str | None
    error_summary: str | None
    retry_count: int


class ExecLogStreamRequest(BaseModel):
    """SSE stream のパラメータ。

    poll_interval_seconds: 状態を再 query する間隔。
    max_duration_seconds: 配信の最大持続時間 (この時間で end イベントを必ず送る)。
    """

    poll_interval_seconds: float = Field(default=2.0, ge=0.1, le=30.0)
    max_duration_seconds: float = Field(default=60.0, ge=1.0, le=600.0)


class ExecLogEvent(BaseModel):
    """SSE 単一 event payload。"""

    type: ExecLogEventType
    execution_id: str
    status: str | None = None
    completed_at: datetime | None = None
    error_summary: str | None = None
    logs_storage_path: str | None = None
    timestamp: datetime
