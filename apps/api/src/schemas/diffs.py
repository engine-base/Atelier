"""GAP-155: バージョン間差分レスポンス (モック/成果物共通)。"""

from __future__ import annotations

from pydantic import BaseModel


class VersionDiffResponse(BaseModel):
    from_id: str
    from_version: int
    to_id: str
    to_version: int
    added: int
    removed: int
    identical: bool
    diff: str
