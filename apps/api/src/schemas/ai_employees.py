"""AI 社員 API スキーマ (T-A-14)。

07_api_design/openapi.yaml#components/schemas/AiEmployee。E-007 ai_employees
(workspace_scoped)。10 名は運営側固定 (作成/削除不可)。ユーザーが編集できるのは
display_name / icon / tone_preset / custom_tone_text のみ (S-C02 モック準拠)。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

TonePreset = Literal["polite", "friendly", "casual", "concise", "coaching"]


class AiEmployeeUpdate(BaseModel):
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
