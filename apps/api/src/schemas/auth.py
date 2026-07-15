"""認証 API スキーマ (T-A-01)。

F-001 ユーザー登録 + F-LEGAL-004 同意取得。signup 時に E-001 users 作成
+ E-025 consents 4 種記録 (terms_of_service / privacy_policy / data_residency /
ai_training_optin)。

T-A-02 signin、T-A-03〜04 (Magic Link/OAuth/Reset)、T-A-05 退会は別タスク。
本 task は新規ユーザー登録時の同意取得のみ責務とする。
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

ConsentType = Literal["terms_of_service", "privacy_policy", "data_residency", "ai_training_optin"]

# DB CHECK 制約 consents_version_semver_or_date と同一 (t-d-11 migration)。
# semver 系 (1 / 1.0 / 1.0.0 …) または YYYY-MM-DD。
_CONSENT_VERSION = re.compile(r"^[0-9]+(\.[0-9]+)*$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$")


class ConsentEntry(BaseModel):
    """同意 1 件。F-LEGAL-004 監査要件。

    accepted: 必須 (terms/privacy は必ず true でないと signup 失敗)
    version: 同意したポリシーの version (semver or YYYY-MM-DD)
    """

    type: ConsentType
    version: str = Field(min_length=1, max_length=50)
    accepted: bool

    @field_validator("version")
    @classmethod
    def _check_version(cls, v: str) -> str:
        # DB CHECK と同じ形式検証を境界で行い、不正入力を 500 でなく 422 で弾く
        # (バグ #25: 実本番 signup で不正 version が opaque な 500 になっていた)。
        if not _CONSENT_VERSION.match(v):
            raise ValueError("version must be semver (e.g. 1.0.0) or YYYY-MM-DD")
        return v


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
    # T-A-04 で発行する refresh_token (opaque, 一意な乱数)。signin 経由
    # 取得時に同時返却し、/auth/refresh で access_token を再発行する。
    refresh_token: str | None = None


# --------------------------------------------------------------------------- #
# T-A-03: Magic Link + OAuth
# --------------------------------------------------------------------------- #
OAuthProvider = Literal["google", "github"]


class MagicLinkRequest(BaseModel):
    """Magic Link 送信リクエスト。

    email に対しメール送信が試行される。レスポンスは常に 202 で email 存在
    を漏らさない (enumeration 防止)。
    """

    email: EmailStr
    redirect_url: str | None = Field(default=None, max_length=500)


class MagicLinkAccepted(BaseModel):
    """202 応答。メール送信したかは隠す (enumeration 防止)。"""

    accepted: bool = True
    delivery: Literal["email"] = "email"


class MagicLinkVerifyRequest(BaseModel):
    """Magic Link 検証リクエスト。token + email を照合し JWT を発行。"""

    email: EmailStr
    token: str = Field(min_length=10, max_length=200)


class OAuthRedirectResponse(BaseModel):
    """OAuth Provider への redirect URL + opaque state (CSRF)。"""

    authorize_url: str
    state: str
    provider: OAuthProvider


# --------------------------------------------------------------------------- #
# T-A-04: Password Reset + JWT Refresh
# --------------------------------------------------------------------------- #
class PasswordResetRequest(BaseModel):
    """パスワードリセット要求。常に 202 (enumeration 防止)。"""

    email: EmailStr


class PasswordResetAccepted(BaseModel):
    accepted: bool = True


class PasswordResetConfirmRequest(BaseModel):
    """リセット確定。token + 新 password。token は server 側 hash と照合。"""

    email: EmailStr
    token: str = Field(min_length=10, max_length=200)
    new_password: str = Field(min_length=8, max_length=128)


class PasswordResetConfirmResponse(BaseModel):
    user_id: str
    email: str
    password_changed_at: datetime


class RefreshRequest(BaseModel):
    """access_token 再発行リクエスト。"""

    refresh_token: str = Field(min_length=10, max_length=200)


class RefreshResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_at: datetime
    refresh_token: str
    """新しい refresh_token (rotate)。古い token は失効される。"""


# --------------------------------------------------------------------------- #
# T-A-05: 退会フロー (30 日猶予, F-LEGAL-002)
# --------------------------------------------------------------------------- #
class AccountDeleteRequest(BaseModel):
    """退会リクエスト。password を要求して step-up 認証する。"""

    password: str = Field(min_length=1, max_length=128)
    reason: str | None = Field(default=None, max_length=2000)


class AccountDeleteResponse(BaseModel):
    """退会受付。30 日後にハード削除される (worker job が処理)。"""

    user_id: str
    scheduled_purge_at: datetime
    deleted_at: datetime


class AccountRestoreRequest(BaseModel):
    """30 日猶予期間中の復活。email + password で再認証する。"""

    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class AccountRestoreResponse(BaseModel):
    user_id: str
    restored_at: datetime
