"""Admin API スキーマ (T-A-43 / T-A-42 / T-A-41)。

T-A-43: AuditLogResponse — E-020 audit_logs。
T-A-42: AdminSkillResponse / AdminTemplateResponse — admin が全 skills /
        AI 社員テンプレを横断管理 (read-only 閲覧)。
T-A-41: AdminDashboardResponse / AdminUserResponse — admin dashboard 集計と
        所属 workspace 横断のメンバー一覧 (workspace_member_details definer 経由)。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class AuditLogResponse(BaseModel):
    id: str
    workspace_id: str | None
    actor_type: str
    actor_id: str
    action: str
    target_type: str
    target_id: str | None
    before: dict[str, object] | None
    after: dict[str, object] | None
    ip_address: str | None
    created_at: datetime


class AdminSkillResponse(BaseModel):
    """運営 admin 向け skill 詳細 (T-A-42)。

    RLS skills_select_all で全 authenticated 可視 だが、admin 用エンドポイントは
    is_active=false を含む全件閲覧 + 詳細管理画面 (S-AD02) で利用される。
    """

    id: str
    name: str
    version: str
    description: str | None
    content_md: str
    assets_storage_path: str | None
    allowed_employee_roles: list[str]
    allowed_employee_ids: list[str]
    is_active: bool
    created_at: datetime
    updated_at: datetime


class AdminTemplateResponse(BaseModel):
    """運営 admin 向け AI 社員テンプレ詳細 (T-A-42)。

    AI 社員テンプレは ai_employee_templates_no_insert/update/delete RESTRICTIVE
    で authenticated は read only。admin 視点では全 version / is_active=false も
    含めて一覧する。編集 (GAP-031⑤ scope expand) は route の admin gate +
    service session 経由でのみ行う。
    """

    id: str
    default_name: str
    default_display_name: str
    default_icon: str | None
    department: str
    role: str
    default_skills: list[str]
    default_knowledge_cats: list[str]
    system_prompt: str
    specialty: str
    version: int
    is_active: bool
    created_at: datetime
    updated_at: datetime


class AdminTemplateUpdate(BaseModel):
    """AI 社員テンプレの部分更新 (GAP-031⑤ / T-A-42 scope expand)。

    未指定フィールドは変更しない。保存のたびに version が自動 increment され、
    テンプレは全 WS の ai_employees.template_id 参照経由で即時反映される。
    default_skills は skills.id (uuid) の配列 — 存在しない値の創作を防ぐため
    形式検証のみここで行い、実在は DB FK の対象外なので admin の明示選択を信頼する。
    """

    default_display_name: str | None = Field(default=None, min_length=1, max_length=100)
    department: (
        Literal[
            "executive",
            "sales",
            "product",
            "architecture",
            "design",
            "dev_qa",
            "cross_functional",
        ]
        | None
    ) = None
    role: Literal["coo", "lead", "member"] | None = None
    system_prompt: str | None = Field(default=None, min_length=1, max_length=20_000)
    specialty: str | None = Field(default=None, max_length=500)
    default_skills: list[str] | None = Field(default=None, max_length=50)
    default_knowledge_cats: list[str] | None = Field(default=None, max_length=50)

    @field_validator("default_skills")
    @classmethod
    def _skills_are_uuids(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        for item in v:
            try:
                UUID(item)
            except ValueError as exc:
                raise ValueError(f"default_skills entry is not a uuid: {item}") from exc
        return v

    @field_validator("default_knowledge_cats")
    @classmethod
    def _cats_not_blank(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        cleaned = [c.strip() for c in v]
        if any(not c or len(c) > 100 for c in cleaned):
            raise ValueError("default_knowledge_cats entries must be 1-100 chars")
        return cleaned


class AdminTemplateDeploymentResponse(BaseModel):
    """テンプレの実展開先 (ai_employees.template_id 参照の実カウント)。"""

    template_id: str
    workspace_count: int
    employee_count: int


class AdminDashboardResponse(BaseModel):
    """T-A-41: 運営 admin dashboard 集計 (admin 所属 workspaces scope 内)。

    cluster-wide な platform 全体集計は cross-workspace definer migration が
    必要なため別途とし、本タスクでは admin が所属する workspace 群の合算を
    返す (current_user_workspaces() を RLS 経由で利用)。
    """

    workspace_count: int
    project_count: int
    ai_employee_count: int
    audit_log_count_24h: int
    generated_at: datetime


class AdminUserResponse(BaseModel):
    """T-A-41: admin scope 内 member 詳細 (workspace_member_details definer 経由)。"""

    user_id: str
    email: str
    display_name: str | None
    role: str
    joined_at: datetime
    workspace_id: str


# --------------------------------------------------------------------------- #
# GAP-019: S-T01 運営ダッシュボード (mission / trends / channels / health /
# beta FB / costs / platform stats)
# --------------------------------------------------------------------------- #
class AdminGoalUpsert(BaseModel):
    """事業 KPI 目標の記録 (運営が明示的に設定 — システムが数値を創作しない)。"""

    title: str = Field(min_length=1, max_length=200)
    target_count: int = Field(gt=0, le=1_000_000)
    deadline: date
    note: str | None = Field(default=None, max_length=2000)


class AdminGoalResponse(BaseModel):
    id: str
    goal_key: str
    title: str
    target_count: int
    deadline: date
    note: str | None
    updated_at: datetime


class AdminMissionResponse(BaseModel):
    """ミッションヒーローの実データ (目標未設定なら goal=None)。

    current_count = 実ワークスペース数、added_30d = 直近 30 日の実増分。
    needed_per_month は残数 / 残月数の実計算。
    """

    goal: AdminGoalResponse | None
    current_count: int
    added_30d: int
    remaining: int | None = None
    months_left: int | None = None
    needed_per_month: int | None = None


class AdminTrendPoint(BaseModel):
    """週次の実累計 (workspaces / projects は created_at 由来)。"""

    week_start: date
    workspaces: int
    projects: int


class AdminTrendsResponse(BaseModel):
    points: list[AdminTrendPoint]
    billing_enabled: bool
    """課金導入済みか。false のとき MRR は実額 ¥0 (ベータ無料運用)。"""

    mrr_yen: int


class AcquisitionCreate(BaseModel):
    channel: Literal["referral", "sns", "personal", "other"]
    note: str | None = Field(default=None, max_length=500)
    occurred_on: date | None = None


class AcquisitionRecordResponse(BaseModel):
    id: str
    channel: str
    note: str
    occurred_on: date
    created_at: datetime


class AcquisitionChannelCount(BaseModel):
    channel: str
    count: int


class AcquisitionsResponse(BaseModel):
    channels: list[AcquisitionChannelCount]
    recent: list[AcquisitionRecordResponse]
    total: int


class HealthCheckRow(BaseModel):
    """実計測 / 実設定状態のみ (推測の稼働率は返さない)。"""

    name: str
    status: Literal["ok", "warn", "err"]
    detail: str
    meta: str


class BetaFeedbackCreate(BaseModel):
    category: Literal["bug", "feature", "praise", "other"] = "other"
    content: str = Field(min_length=1, max_length=4000)


class BetaFeedbackResponse(BaseModel):
    id: str
    email: str
    category: str
    content: str
    status: str
    created_at: datetime
    resolved_at: datetime | None


class AdminCostCreate(BaseModel):
    month: date
    """記録対象の月 (何日でも可 — 月初に正規化される)。"""

    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=500)
    amount_yen: int = Field(ge=0, le=100_000_000)


class AdminCostResponse(BaseModel):
    id: str
    month: date
    name: str
    description: str
    amount_yen: int


class AdminCostsResponse(BaseModel):
    month: date
    items: list[AdminCostResponse]
    total_yen: int


class AdminPlatformStatsResponse(BaseModel):
    """platform 全体の実集計 (service session — admin gate 必須)。"""

    task_executions_30d: int
    avg_score_30d: float | None
    beta_feedback_total: int
    beta_feedback_open: int
    bridge_connected: int
    users_total: int
    users_deleted_30d: int
    workspaces_added_30d: int


class ErrorLogEntry(BaseModel):
    """GAP-182: 自前のエラーログ 1 件 (運営 admin のみ閲覧)。

    外部 SaaS (Sentry) には送らない。秘匿値はサーバー側でマスク済み。
    """

    id: str
    occurred_at: datetime
    source: Literal["api", "web", "worker"]
    level: Literal["error", "warning"]
    kind: str
    message: str
    path: str | None
    method: str | None
    status_code: int | None
    #: 同種エラーをまとめる key
    fingerprint: str
    #: 同じ fingerprint の直近 24h 件数 (増えているかを見る)
    count_24h: int


class ClientErrorReport(BaseModel):
    """画面 (Next.js) 側で起きたエラーの報告 (GAP-182)。"""

    kind: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=1000)
    path: str | None = Field(default=None, max_length=500)
    stack: str | None = Field(default=None, max_length=8000)
