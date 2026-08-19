"""Storage 署名付き URL 共有スキーマ。"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ContentUrlResponse(BaseModel):
    """storage コンテンツの一時閲覧用 署名付き URL。

    GAP-176: `kind` は「中身が何か」— 受け手 (S-G01 ビューア) が表示方法を
    決めるために使う。これが無いと Excel/PDF まで HTML の iframe に流し込み、
    空の白い枠が出る。既定は html (従来の挙動と互換)。
    """

    url: str
    kind: Literal["html", "pdf", "image", "sheet", "binary"] = "html"
    file_name: str | None = None
    mime: str | None = None
