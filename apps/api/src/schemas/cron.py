"""cron スケジュール API スキーマ (T-A-40)。

cron_schedules は project-scoped、target_action ∈ {task_replay,
knowledge_organize, industry_extract, report_summary, daily_digest,
weekly_burndown} の cron job スケジュール。RLS は member 可視 / owner-member
編集 / owner 削除。GAP-179 で発火まで配線済 (services/cron/dispatcher)。
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


class CronRunResponse(BaseModel):
    """cron 実行履歴 1 件 (GAP-013)。detail は運用メタのみ (テナントデータ無し)。"""

    id: str
    name: str
    schedule_id: str | None
    project_id: str | None
    started_at: datetime
    finished_at: datetime | None
    status: Literal["running", "success", "error", "deferred"]
    detail: dict[str, object]


class PlatformJobLastRun(BaseModel):
    """プラットフォームジョブの最終実行 (cron_run_history 実データ)。"""

    started_at: datetime
    finished_at: datetime | None
    status: Literal["running", "success", "error", "deferred"]


class PlatformJobResponse(BaseModel):
    """プラットフォーム必須ジョブ 1 件 (GAP-014 — S-O01 法令・運用節、read-only)。

    required=True (legal) は法令対応のため無効化不可。last_run が null なら
    まだ一度も実行されていない (稼働状況を偽装しない)。
    """

    name: str
    category: Literal["legal", "report", "pipeline"]
    required: bool
    title: str
    description: str
    cron: str
    schedule_label: str
    next_run_at: datetime | None
    last_run: PlatformJobLastRun | None


class CronActionResponse(BaseModel):
    """自動実行の種類 1 件のメタ情報 (GAP-179)。

    画面のコスト表示・説明はこの API を読む。「画面の説明」と「実際に走る処理」が
    別々に書かれていたために「BYOK API 使用」という誤表示が出ていたため、
    実行コード (services/cron/actions.py) を唯一の信頼源にする。
    """

    action: CronTargetAction
    title: str
    description: str
    group: Literal["impl", "knowledge", "notify"]
    staff: str
    #: True = 実行に本人の PC (Bridge) の接続が要る。未接続なら保留して再試行する。
    requires_bridge: bool
    #: 「本人の Claude プラン枠」/「コスト無料」
    cost_label: str
    cost_note: str
