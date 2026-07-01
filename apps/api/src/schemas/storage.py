"""Storage 署名付き URL 共有スキーマ。"""

from __future__ import annotations

from pydantic import BaseModel


class ContentUrlResponse(BaseModel):
    """storage コンテンツの一時閲覧用 署名付き URL。"""

    url: str
