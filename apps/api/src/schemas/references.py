"""GAP-161: スタジオ (モック / デザインテンプレ) の参考資料アップロード。

チャットの添付 (thread 紐づき) とは別に、デザイン作業の「参考にしてほしい資料」
を渡すための最小 API。実体は同じ storage + 同じ抽出器を使う。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ReferenceUploadRequest(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(min_length=1, max_length=255)
    file_size_bytes: int = Field(ge=1)


class ReferenceUploadResponse(BaseModel):
    upload_url: str
    storage_path: str


class ReferenceFile(BaseModel):
    """アップロード済みの参考資料 (生成/改訂リクエストに添える)。"""

    storage_path: str = Field(min_length=1, max_length=500)
    file_name: str = Field(min_length=1, max_length=255)
    mime_type: str = Field(default="", max_length=255)
