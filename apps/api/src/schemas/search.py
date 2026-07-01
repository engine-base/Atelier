"""横断検索（/search）スキーマ — T-UC-40。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

SearchKind = Literal["project", "task", "knowledge", "employee"]


class SearchHit(BaseModel):
    """検索ヒット 1 件。kind ごとに title/snippet の由来が異なる。"""

    id: str
    kind: SearchKind
    title: str
    snippet: str
