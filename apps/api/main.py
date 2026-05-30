"""Atelier FastAPI エントリポイント。

uvicorn apps.api.main:app --host 0.0.0.0 --port 8000

OpenAPI 契約 (07_api_design/openapi.yaml) との drift は T-F-25 / T-F-26
(Schemathesis contract test) で検出する。
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src import __version__
from src.health import router as health_router
from src.routes import api_router


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
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

# フロントエンド (Next.js :3000) からの cookie 付きリクエストを許可。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(api_router)
