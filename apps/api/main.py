"""Atelier FastAPI エントリポイント。

uvicorn apps.api.main:app --host 0.0.0.0 --port 8000

OpenAPI 契約 (07_api_design/openapi.yaml) との drift は T-F-25 / T-F-26
(Schemathesis contract test) で検出する。
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src import __version__
from src.errors import UnhandledErrorMiddleware
from src.health import router as health_router
from src.routes import api_router
from src.txn_commit import CommitBeforeResponseMiddleware

# .env を os.environ に読み込む (既にある環境変数が常に優先)。
# これまで DB 設定 (pydantic-settings) だけが .env を読み、CORS / LLM provider /
# Bridge トークン等は「ターミナルに export した時だけ効く」状態だった —
# 再起動のたびに設定が消える事故 (2026-08-17 Mac 実機で再発) の恒久対策。
load_dotenv()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None, None]:
    # DB pool / LLM client 等の初期化は T-F-11 / T-F-12 で追加
    # GAP-133: ローカル埋め込みのウォームアップ (バックグラウンド —
    # 初回のモデル DL でユーザー操作をブロックしない。完了後に未埋め込み行を
    # 自動バックフィル。失敗しても API は正常稼働)
    from src.services.knowledge import schedule_local_embedding_warmup

    schedule_local_embedding_warmup()

    # GAP-178: 「今どの経路で AI が動き、誰の費用か」を起動時に必ず 1 行出す。
    # env の中身を読みに行かないと分からない状態 (= 設定ミスに気づけない状態)
    # を作らないための可視化。警告があれば warning レベルで出す。
    import logging as _logging

    from src.services.chat_sse.llm_route import describe_llm_route, resolve_llm_route

    _route = resolve_llm_route()
    _log = _logging.getLogger("atelier.llm_route")
    (_log.warning if _route.warnings else _log.info)(describe_llm_route())

    # GAP-180: 意味検索 (埋め込み) も同様に 1 行出す。
    from src.embeddings.route import describe_embedding_route, resolve_embedding_route

    _emb = resolve_embedding_route()
    _emb_log = _logging.getLogger("atelier.embedding_route")
    (_emb_log.warning if _emb.warnings else _emb_log.info)(describe_embedding_route())

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

# 未捕捉例外を CORS ヘッダ付きの JSON 500 に変換する (CORS より内側に置く)。
# 素の 500 には CORS ヘッダが付かず、ブラウザでは「CORS エラー」に見えて
# 真因 (サーバー例外) を隠してしまう — 誤診 2 回 (knowledge / connection-status)
# の恒久対策。traceback はサーバーログに出る。
app.add_middleware(UnhandledErrorMiddleware)

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

# レスポンス送信前に RLS セッションを commit する (read-your-own-write 整合)。
# yield 依存の teardown commit はレスポンス送信後のため、直後のリクエストが
# 未コミット行を読めない race があった (S-H01 design-audit で検出)。
app.add_middleware(CommitBeforeResponseMiddleware)

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
