"""Admin API スキーマ (T-A-43 / T-A-42 / T-A-41)。

T-A-43: AuditLogResponse — E-020 audit_logs。
T-A-42: AdminSkillResponse / AdminTemplateResponse — admin が全 skills /
        AI 社員テンプレを横断管理 (read-only 閲覧)。
T-A-41: AdminDashboardResponse / AdminUserResponse — admin dashboard 集計と
        所属 workspace 横断のメンバー一覧 (workspace_member_details definer 経由)。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


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
    含めて一覧する。
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
