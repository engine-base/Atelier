"""cron スケジュール API スキーマ (T-A-40)。

cron_schedules は project-scoped、target_action ∈ {task_replay,
knowledge_organize, industry_extract, report_summary, daily_digest,
weekly_burndown} の cron job スケジュール。RLS は member 可視 / owner-member
編集 / owner 削除。Inngest 連動 (T-F-20) は別 PR で配線、本タスクは CRUD のみ。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

CronTargetAction = Literal[
    "task_replay",
    "knowledge_organize",
    "industry_extract",
    "report_summary",
    "daily_digest",
    "weekly_burndown",
]


class CronScheduleCreate(BaseModel):
    project_id: str
    name: str = Field(min_length=1, max_length=100)
    cron_expression: str = Field(min_length=1, max_length=100)
    target_action: CronTargetAction
    target_payload: dict[str, object] = Field(default_factory=dict)
    enabled: bool = True


class CronScheduleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    cron_expression: str | None = Field(default=None, min_length=1, max_length=100)
    target_action: CronTargetAction | None = None
    target_payload: dict[str, object] | None = None
    enabled: bool | None = None


class CronScheduleResponse(BaseModel):
    id: str
    project_id: str
    name: str
    cron_expression: str
    target_action: str
    target_payload: dict[str, object]
    enabled: bool
    next_run_at: datetime | None
    created_at: datetime
    updated_at: datetime
