"""Admin API スキーマ (T-A-43 / T-A-42)。

T-A-43: AuditLogResponse — E-020 audit_logs。
T-A-42: AdminSkillResponse / AdminTemplateResponse — 運営 admin が全 skills /
        AI 社員テンプレを横断管理 (read-only 閲覧)。
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
