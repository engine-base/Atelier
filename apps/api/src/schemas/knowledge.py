"""ナレッジ (knowledge_nodes) API スキーマ (T-A-36)。

E-018 knowledge_nodes (polymorphic account, soft_delete)。
account_type は workspace | user、scope は common | employee_specific。
embedding は Voyage AI で生成され DB 側で保持 (1024-dim)。

API 応答では embedding は返さず (重い + 不要)、search endpoint だけが
内部で Voyage embed → cosine 検索を実行する。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

KnowledgeAccountType = Literal["workspace", "user"]
KnowledgeScope = Literal["common", "employee_specific"]
KnowledgeSourceType = Literal["manual", "ai_extracted", "import", "mem0"]


class KnowledgeCreate(BaseModel):
    """ナレッジ作成。

    scope='employee_specific' なら owner_employee_id 必須。
    scope='common' なら owner_employee_id は省略 (DB の constraint と一致)。
    """

    account_id: str
    account_type: KnowledgeAccountType
    scope: KnowledgeScope
    category: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=200)
    content_md: str = Field(min_length=1)
    tags: list[str] = Field(default_factory=list, max_length=50)
    owner_employee_id: str | None = None
    source_type: KnowledgeSourceType = "manual"
    source_project_id: str | None = None
    confidence_score: float = Field(default=0.5, ge=0.0, le=1.0)
    is_anonymized: bool = False


class KnowledgeUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    content_md: str | None = Field(default=None, min_length=1)
    category: str | None = Field(default=None, min_length=1, max_length=100)
    tags: list[str] | None = Field(default=None, max_length=50)
    confidence_score: float | None = Field(default=None, ge=0.0, le=1.0)
    is_anonymized: bool | None = None


class KnowledgeResponse(BaseModel):
    id: str
    account_id: str
    account_type: KnowledgeAccountType
    scope: KnowledgeScope
    owner_employee_id: str | None
    category: str
    title: str
    content_md: str
    tags: list[str]
    source_type: str
    source_project_id: str | None
    confidence_score: float
    usage_count: int
    is_anonymized: bool
    approved_by_user_id: str | None
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class KnowledgeSearchHit(BaseModel):
    """semantic 検索ヒット。score は cosine similarity (0..1)。"""

    knowledge: KnowledgeResponse
    score: float


class KnowledgeSearchResponse(BaseModel):
    query: str
    hits: list[KnowledgeSearchHit]
    total: int


# --------------------------------------------------------------------------- #
# T-A-37: ナレッジ昇格 + 横断パターン抽出 (F-K02, S-K02)
# --------------------------------------------------------------------------- #
class KnowledgePromoteRequest(BaseModel):
    """user-scope ナレッジを workspace common に昇格するリクエスト。

    target_workspace_id: 昇格先 workspace (本人が member 以上であること必須)。
    confidence_score: 昇格後の信頼度 (デフォルトは元の値を維持)。
    """

    target_workspace_id: str
    confidence_score: float | None = Field(default=None, ge=0.0, le=1.0)


class KnowledgePatternRequest(BaseModel):
    """横断パターン抽出リクエスト。

    account_id: workspace の集約スコープ (本人が見える範囲)。
    category: 任意のカテゴリでフィルタ。
    min_occurrences: パターンとして抽出する最小出現回数 (デフォルト 2)。
    limit: 上位 N パターンまで返す (デフォルト 20)。
    """

    account_id: str | None = None
    category: str | None = None
    min_occurrences: int = Field(default=2, ge=2, le=100)
    limit: int = Field(default=20, ge=1, le=200)


class KnowledgePattern(BaseModel):
    """検出された横断パターン (共通タグ集合の凝集)。

    pattern_tags: パターンを構成する共通 tag 集合 (順序維持)。
    occurrence_count: パターンが出現したナレッジ件数。
    representative_ids: パターンを代表するナレッジ id (上位 confidence 順、最大 5)。
    avg_confidence: 構成ナレッジの confidence 平均。
    """

    pattern_tags: list[str]
    occurrence_count: int
    representative_ids: list[str]
    avg_confidence: float


class KnowledgePatternResponse(BaseModel):
    total: int
    patterns: list[KnowledgePattern]
