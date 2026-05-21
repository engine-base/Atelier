"""Atelier FastAPI エントリポイント。

uvicorn apps.api.main:app --host 0.0.0.0 --port 8000

OpenAPI 契約 (07_api_design/openapi.yaml) との drift は T-F-25 / T-F-26
(Schemathesis contract test) で検出する。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from .src import __version__
from .src.health import router as health_router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # DB pool / LLM client 等の初期化は T-F-11 / T-F-12 で追加
    yield


app = FastAPI(
    title="Atelier API",
    description="AI 社員常駐型プロジェクト管理 SaaS — backend",
    version=__version__,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

app.include_router(health_router)
