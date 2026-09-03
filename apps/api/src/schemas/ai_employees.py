"""AI 社員 API スキーマ (T-A-14 / T-A-15)。

07_api_design/openapi.yaml#components/schemas/AiEmployee。E-007 ai_employees
(workspace_scoped)。10 名は運営側固定 (作成/削除不可)。ユーザーが編集できるのは
display_name / icon / tone_preset / custom_tone_text のみ (S-C02 モック準拠)。

T-A-15: AI 社員テンプレ (ai_employee_templates) は運営側固定。authenticated は
SELECT のみ (RLS RESTRICTIVE で insert/update/delete 不可) のため read-only。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TonePreset = Literal["polite", "friendly", "casual", "concise", "coaching"]


class AiEmployeeUpdate(BaseModel):
    # GAP-275 (通し J37-04): system_prompt / attached_skills 等の運営専用項目を
    # 黙って捨てない。含まれていたら 422 (FORBIDDEN_FIELD) で拒否する。
    model_config = ConfigDict(extra="forbid")

    display_name: str | None = Field(default=None, min_length=1, max_length=100)
    icon: str | None = None
    tone_preset: TonePreset | None = None
    custom_tone_text: str | None = Field(default=None, max_length=500)


class AiEmployeeResponse(BaseModel):
    id: str
    workspace_id: str
    template_id: str | None
    name: str
    display_name: str
    icon: str | None
    role: str
    department: str
    tone_preset: str
    custom_tone_text: str | None
    attached_skills: list[str]
    attached_knowledge_cats: list[str]
    is_default: bool
    archived: bool
    created_at: datetime
    updated_at: datetime


class AiEmployeeTemplateResponse(BaseModel):
    id: str
    default_name: str
    default_display_name: str
    default_icon: str | None
    department: str
    role: str
    # GAP-274 (通し J37-02 / R-T06): 指示文とスキル構成は運営専用。
    # 一般利用者には default_skills=[] / system_prompt=None で返す。
    default_skills: list[str]
    default_knowledge_cats: list[str]
    system_prompt: str | None
    specialty: str
    version: int
    is_active: bool
    created_at: datetime
    updated_at: datetime


class EmployeeActivityResponse(BaseModel):
    """AI 社員の活動 1 件 (GAP-008)。tasks/decisions/executions/threads の横断集計。"""

    type: Literal["task", "decision", "execution", "thread"]
    title: str
    detail: str | None
    at: datetime


class EmployeeIconUploadUrlRequest(BaseModel):
    """アイコン画像アップロード用 署名付き URL 要求 (GAP-009 / S-C02)。"""

    file_name: str = Field(min_length=1, max_length=200)
    mime_type: str = Field(min_length=1, max_length=100)
    file_size_bytes: int = Field(ge=1)


class EmployeeIconUploadUrlResponse(BaseModel):
    """署名付きアップロード URL (2 段階アップロードの 1 段目)。

    storage_path は PUT 完了後に PATCH /ai-employees/{id} の icon へ格納する。
    """

    upload_url: str
    storage_path: str


class EmployeeIconUrlResponse(BaseModel):
    """アイコン画像 (icon が storage path のとき) の署名付き閲覧 URL。"""

    url: str
