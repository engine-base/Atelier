"""GAP-153: ナレッジ自動キュレーション API スキーマ (運営 admin 専用)。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from src.schemas.knowledge import KnowledgeResponse


class CurationRunStats(BaseModel):
    """バッチ 1 回分の実測 (何件走査し、何件が提案/除外になったか)。"""

    scanned: int = 0
    proposed: int = 0
    skipped_not_useful: int = 0
    rejected_security: int = 0


class CurationRunRequest(BaseModel):
    limit: int = Field(default=20, ge=1, le=100)


class KnowledgeCurationResponse(BaseModel):
    id: str
    source_node_id: str
    source_account_type: str
    # 運営の監査用 (テナントには一切見えない — RLS default deny)
    source_title: str | None = None
    source_workspace_name: str | None = None
    proposed_title: str
    proposed_content_md: str
    proposed_category: str
    proposed_tags: list[str] = Field(default_factory=list)
    reason: str
    security_notes: str | None = None
    status: Literal["pending", "approved", "rejected", "rejected_security", "skipped"]
    model: str | None = None
    published_node_id: str | None = None
    reviewed_at: datetime | None = None
    created_at: datetime


class CurationApproveResponse(BaseModel):
    curation: KnowledgeCurationResponse
    published: KnowledgeResponse
