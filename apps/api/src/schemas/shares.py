"""GAP-162: 成果物の共有リンク schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ShareLinkCreateRequest(BaseModel):
    label: str = Field(default="", max_length=120)
    expires_days: int = Field(default=14, ge=1, le=180)


class ShareLinkResponse(BaseModel):
    id: str
    output_id: str
    label: str
    expires_at: datetime
    revoked_at: datetime | None = None
    view_count: int
    last_viewed_at: datetime | None = None
    created_at: datetime
    #: 発行直後のみ返る共有 URL (ハッシュしか保存しないため後から再取得できない)
    share_url: str | None = None
