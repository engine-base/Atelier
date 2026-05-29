"""認証 API スキーマ (T-A-01)。

F-001 ユーザー登録 + F-LEGAL-004 同意取得。signup 時に E-001 users 作成
+ E-025 consents 4 種記録 (terms_of_service / privacy_policy / data_residency /
ai_training_optin)。

T-A-02 signin、T-A-03〜04 (Magic Link/OAuth/Reset)、T-A-05 退会は別タスク。
本 task は新規ユーザー登録時の同意取得のみ責務とする。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

ConsentType = Literal["terms_of_service", "privacy_policy", "data_residency", "ai_training_optin"]


class ConsentEntry(BaseModel):
    """同意 1 件。F-LEGAL-004 監査要件。

    accepted: 必須 (terms/privacy は必ず true でないと signup 失敗)
    version: 同意したポリシーの version (semver or YYYY-MM-DD)
    """

    type: ConsentType
    version: str = Field(min_length=1, max_length=50)
    accepted: bool


class SignupRequest(BaseModel):
    """signup リクエスト。

    email + password で Supabase Auth (auth.users) を作成し、public.users と
    consents を同時記録する atomic 操作。
    """

    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=100)
    consents: list[ConsentEntry] = Field(min_length=2, max_length=4)


class SignupResponse(BaseModel):
    """signup 結果 (JWT は含まない — signin で発行する)。"""

    user_id: str
    email: str
    display_name: str
    consents_recorded: int
    created_at: datetime


class ConsentRecord(BaseModel):
    """consents テーブル 1 行に対応 (T-A-02 以降 read で利用)。"""

    id: str
    user_id: str
    type: ConsentType
    version: str
    accepted: bool
    accepted_at: datetime
    ip_address: str | None
    user_agent: str | None


# --------------------------------------------------------------------------- #
# T-A-02: signin + 5 回失敗ロック
# --------------------------------------------------------------------------- #
class SigninRequest(BaseModel):
    """signin リクエスト。Supabase Auth の grant_type=password と互換。"""

    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class SigninResponse(BaseModel):
    """signin 成功時の JWT セット。

    access_token: HS256 JWT (sub=user.id, exp, aud='authenticated')。
    token_type: 'bearer' 固定。
    expires_at: access_token の有効期限 (UTC)。
    """

    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_at: datetime
    user_id: str
    email: str
    display_name: str | None
