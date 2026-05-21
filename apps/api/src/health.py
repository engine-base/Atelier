"""ヘルスチェックエンドポイント。

監視（Better Stack uptime monitor / Fly.io healthcheck）からの GET /health を
受け、サービス稼働状態と version を返す。DB / 外部依存の到達性チェックは
T-F-11 (asyncpg + SQLAlchemy) 完了後に拡張する。
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

from . import __version__

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: Literal["atelier-api"]
    version: str


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="サービスヘルスチェック",
    description="サービス稼働状態を返す。監視 / LB から呼び出される。",
)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", service="atelier-api", version=__version__)
