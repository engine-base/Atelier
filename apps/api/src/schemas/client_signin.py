"""クライアント別 JWT signin + project view スキーマ (T-A-35 / R-T08 致命級)。

E-017 client_invitations の invitation_token を引き換えに、project_id に
限定された client_portal JWT を発行する。R-T08: 1 クライアント JWT は
1 project のみ可視 (越境完全分離)。

経営者承認: R-T08 (T-D-22) は経営者承認済として実装 (越境試験 PASS 必須)。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ClientSigninRequest(BaseModel):
    """招待トークンでのクライアントサインイン。

    invitation_token: client_invitations.token_hash の元の plaintext。
    display_name: 任意。初回サインイン時に client_display_name を補完する。
    agree_legal / agree_confidential: 同意 2 種 (GAP-028)。サーバー側で両方
    true を必須とし、初回同意時刻を client_invitations に永続する。
    """

    invitation_token: str = Field(min_length=10, max_length=200)
    display_name: str | None = Field(default=None, max_length=100)
    agree_legal: bool = False
    agree_confidential: bool = False


class ClientInvitationPreviewRequest(BaseModel):
    """招待トークンの署名前プレビュー要求 (GAP-028)。

    トークンを URL に載せない (アクセスログ流出防止) ため POST body で受ける。
    """

    invitation_token: str = Field(min_length=10, max_length=200)


class ClientInvitationPreview(BaseModel):
    """招待トークンの署名前プレビュー (GAP-028 / S-L02)。

    メタ限定: プロジェクト内部 ID・スコープ詳細・トークン類は返さない。
    invited_email はトークン保持者 = 招待メールの受信者本人であるため開示可。
    inviter_name は招待元 workspace オーナーの表示名 (未設定なら null —
    推測で埋めない)。
    """

    project_name: str
    workspace_name: str
    inviter_name: str | None
    invited_email: str
    expires_at: datetime
    remaining_days: int


class ClientProjectRef(BaseModel):
    id: str
    name: str


class ClientSigninResponse(BaseModel):
    """client_portal JWT + 限定 project 情報。"""

    client_access_token: str
    token_type: str = "bearer"
    expires_at: datetime
    project: ClientProjectRef
    scopes: list[str]


class ClientProjectView(BaseModel):
    """クライアント向け限定 project ビュー (S-L03)。

    内部メタ (lifecycle 等) は出さず、クライアントが見てよい最小情報のみ。
    """

    id: str
    name: str
    description: str | None
    scopes: list[str]
    viewed_as_client_display_name: str | None


# --------------------------------------------------------------------------- #
# GAP-029: S-L03 クライアントポータル実コンテンツ (client スコープ read API)。
# R-T08: 全て client_portal JWT の project_id claim に限定 (越境 403)。
# 内部メタ (storage path・担当者 ID・phase description 等) は返さない。
# --------------------------------------------------------------------------- #
class ClientPhaseItem(BaseModel):
    """クライアント向け工程 (進捗バー用の最小情報)。"""

    name: str
    order: int
    status: str
    """pending / in_progress / completed / skipped (実 DB 値)。"""


class ClientProjectOverview(BaseModel):
    """S-L03 ヘッダカード + バナー用の実データ。

    progress_percent は completed 工程数 / 全工程数の実計算 (工程 0 件は 0)。
    link_expires_at / link_remaining_days は当該招待の実有効期限。
    operator_* は運営 workspace 名とオーナー表示名 (未設定は null — 創作しない)。
    """

    phases: list[ClientPhaseItem]
    progress_percent: int
    operator_workspace_name: str | None
    operator_name: str | None
    link_expires_at: datetime | None
    link_remaining_days: int | None


class ClientOutputItem(BaseModel):
    """クライアント向け成果物 (stage 毎の最新版のみ)。"""

    id: str
    stage: str
    stage_label: str
    version: int
    updated_at: datetime
    formats: list[str]
    """実在する形式のみ (html / json / md)。"""

    summary: str | None


class ClientMockItem(BaseModel):
    """クライアント向けモック (screen_name 毎の最新版)。"""

    id: str
    screen_name: str
    version: int
    updated_at: datetime


class ClientMocksResponse(BaseModel):
    items: list[ClientMockItem]
    total_screens: int


class ClientCommentCreate(BaseModel):
    """クライアントのコメント投稿 (comment スコープ必須)。

    target は当該 project に属する成果物 / モックのみ (越境 target は 404)。
    """

    target_type: str = Field(pattern="^(workflow_output|mock)$")
    target_id: str
    content: str = Field(min_length=1, max_length=4000)


class ClientCommentUpdate(BaseModel):
    """クライアント自身のコメントの本文修正 (GAP-267)。"""

    content: str = Field(min_length=1, max_length=4000)


class ClientCommentItem(BaseModel):
    """クライアント自身のコメント + 運営からの返信。"""

    id: str
    target_type: str
    target_id: str
    target_label: str | None
    content: str
    author_name: str | None
    is_client_author: bool
    created_at: datetime
