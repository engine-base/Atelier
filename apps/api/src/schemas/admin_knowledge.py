"""運営ナレッジ管理 API スキーマ (T-A-50 / F-023)。

platform(運営デフォルト)ナレッジは account_type/account_id を client から受け取らず、
サービス層で account_type=platform + 固定 sentinel account_id に固定する。
編集は schemas.knowledge.KnowledgeUpdate を、応答は KnowledgeResponse を再利用する。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AdminKnowledgeCreate(BaseModel):
    """運営デフォルトナレッジ新規作成。account_type/account_id は server 側で固定。"""

    category: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    content_md: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list, max_length=50)
    parent_id: str | None = None
    # 運営デフォルトは既定でツリー非表示（RAG 横断参照のみ）。
    visible_in_tree: bool = False
    confidence_score: float = Field(default=0.5, ge=0.0, le=1.0)
