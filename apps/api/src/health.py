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


class CapabilitiesResponse(BaseModel):
    """GAP-285 (G-11: 外部リソースの実在): このイメージに部品が入っているか。

    「入れたつもり」を deploy 直後に機械で確かめるための口。秘密は載せず、
    **部品が import できるか**だけを返す (認証不要 = デプロイ直後に叩ける)。
    """

    embeddings: bool
    """意味検索の部品 (fastembed) がこのサーバーに入っているか。"""

    transcription: bool
    """文字起こしの部品 (faster-whisper) がこのサーバーに入っているか。"""

    embedding_provider: str
    """いま意味検索を担当しているもの (local / voyage / none)。"""

    embedding_state: str
    """ready / preparing / unavailable。"""


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="サービスヘルスチェック",
    description="サービス稼働状態を返す。監視 / LB から呼び出される。",
)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", service="atelier-api", version=__version__)


def _transcription_available() -> bool:
    """faster-whisper が入っているか (import できるか) だけを見る。"""
    import importlib.util

    return importlib.util.find_spec("faster_whisper") is not None


@router.get(
    "/health/capabilities",
    response_model=CapabilitiesResponse,
    summary="このサーバーに入っている部品 (GAP-285)",
    description=(
        "意味検索・文字起こしの部品が **実際に入っているか** を返す。"
        "deploy 直後にこれを見ることで、「入れたつもりで入っていない」を"
        "本番で最初のユーザーが踏む前に検出する (G-11)。"
    ),
)
async def capabilities() -> CapabilitiesResponse:
    from src.embeddings import local as local_emb
    from src.embeddings.route import resolve_embedding_route

    route = resolve_embedding_route()
    return CapabilitiesResponse(
        embeddings=local_emb.local_available(),
        transcription=_transcription_available(),
        embedding_provider=route.provider,
        embedding_state=route.state,
    )
