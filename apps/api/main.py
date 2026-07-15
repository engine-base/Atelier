"""Atelier FastAPI エントリポイント。

uvicorn apps.api.main:app --host 0.0.0.0 --port 8000

OpenAPI 契約 (07_api_design/openapi.yaml) との drift は T-F-25 / T-F-26
(Schemathesis contract test) で検出する。
"""

from __future__ import annotations

import os
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

# フロントエンド (Next.js) からの cookie 付きリクエストを許可。
#   - dev:  localhost / 127.0.0.1 の任意ポート (:3000, :3100, :3200 等)
#   - prod: Vercel (*.vercel.app, engine-bases-projects) + 本番カスタムドメイン
# 追加ドメインは ATELIER_CORS_EXTRA_ORIGINS (カンマ区切り) で投入可能。
_extra = [
    o.strip() for o in os.environ.get("ATELIER_CORS_EXTRA_ORIGINS", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_extra,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?|https://([a-z0-9-]+\.)*vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(api_router)

# T-A-53: Inngest serve (cron worker 経路)。既定 OFF — ATELIER_INNGEST_ENABLED=1 の
# ときのみ /api/inngest を mount し、cron functions (daily-digest 等) を配信する。
if os.environ.get("ATELIER_INNGEST_ENABLED") == "1":
    import inngest.fast_api

    from inngest_config import get_client
    from src.cron import register_cron_jobs

    _inngest_client = get_client()
    inngest.fast_api.serve(app, _inngest_client, register_cron_jobs(_inngest_client))
