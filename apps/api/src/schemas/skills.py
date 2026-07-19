"""スキル管理 API スキーマ (T-A-49 / F-007)。

E-009 skills の管理（運営 admin 専用）。SKILL.md の content_md を upload/編集/新規登録し、
version は semver (name+version unique)。書込は RLS で禁止のため service_role 経由。
応答は schemas.admin.AdminSkillResponse を再利用する。
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

_SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$")


class SkillLiteResponse(BaseModel):
    """認証ユーザー向けスキルカタログ (S-C01/S-C02 表示用 read-only)。"""

    id: str
    name: str
    version: str
    description: str | None
    is_active: bool


class SkillCreate(BaseModel):
    """スキル新規登録（SKILL.md upload）。name+version は unique・version は semver。"""

    name: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=64)
    content_md: str = Field(min_length=1)
    description: str | None = None
    assets_storage_path: str | None = None
    allowed_employee_roles: list[str] = Field(default_factory=list, max_length=50)
    allowed_employee_ids: list[str] = Field(default_factory=list, max_length=200)
    is_active: bool = True

    @field_validator("version")
    @classmethod
    def _semver(cls, v: str) -> str:
        if not _SEMVER.match(v):
            raise ValueError("version must be semver (e.g. 1.0.0)")
        return v


class SkillUpdate(BaseModel):
    """スキル編集（name/version は不変。新バージョンは create で別行）。"""

    content_md: str | None = Field(default=None, min_length=1)
    description: str | None = None
    assets_storage_path: str | None = None
    allowed_employee_roles: list[str] | None = Field(default=None, max_length=50)
    allowed_employee_ids: list[str] | None = Field(default=None, max_length=200)
    is_active: bool | None = None


class SkillAttachRequest(BaseModel):
    """AI 社員へのスキル装着 / 解除。attached=true で装着、false で解除。"""

    ai_employee_id: str
    attached: bool = True
