"""MCP トークン管理 API スキーマ (T-A-08)。

mcp_tokens は workspace-scoped。token plaintext は DB に保存せず sha256-hex
hash のみ保存し、create 応答で 1 度だけ plaintext を返す (一般的な API key
パターン)。可視性は RLS (T-D-21 / mcp_tokens_*_member) が信頼源、revoke は
owner ロールのみ。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class McpTokenCreate(BaseModel):
    workspace_id: str
    name: str = Field(min_length=1, max_length=100)
    scopes: list[str] = Field(default_factory=list)
    expires_at: datetime | None = None


class McpTokenResponse(BaseModel):
    id: str
    workspace_id: str
    name: str
    scopes: list[str]
    expires_at: datetime | None
    revoked_at: datetime | None
    last_used_at: datetime | None
    created_at: datetime
    updated_at: datetime


class McpTokenCreateResponse(McpTokenResponse):
    """作成直後の応答 — plaintext token を 1 度だけ返す (再表示不可)。"""

    token: str
