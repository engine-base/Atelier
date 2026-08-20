# syntax=docker/dockerfile:1.7
# Atelier API — production Docker image (T-F-06 follow-up)
#
# selected-stack.json#python_runtime = "Python 3.12 + uv (Astral)"
# Fly.io NRT で uvicorn を 1 worker で起動。Inngest worker は別 process group
# (T-F-13) で同居予定。

# GAP-200: サーバー側で意味検索 (埋め込み) / 文字起こし (whisper) を動かすか。
#   既定 0 = 入れない。**運営費用を勝手に増やさない**ため。
#   1 にすると localrag extra (fastembed / faster-whisper) を同梱し、
#   モデルをビルド時に取り込む (初回リクエストで数百 MB DL するのを避ける)。
#   ⚠ 1 にする場合は fly.toml の memory を 1024mb 以上へ上げること
#     (実測: 埋め込み 652MB〜1,554MB / whisper 302MB〜1,007MB)。
ARG INSTALL_LOCALRAG=0

# ─── Stage 1: builder ─ uv で deps を install ───────────────────
FROM python:3.12-slim-bookworm AS builder
ARG INSTALL_LOCALRAG

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never

# uv (Astral) を pip 経由で install (selected-stack 指定)
RUN pip install --no-cache-dir uv==0.5.11

WORKDIR /app

# workspace ルートの pyproject.toml + apps/api/pyproject.toml + lock を先にコピー
# (deps レイヤを変更頻度の少ないファイルだけにして cache hit 率向上)
COPY pyproject.toml uv.lock* ./
COPY apps/api/pyproject.toml ./apps/api/

# apps/api 配下の deps だけ install (--package=atelier-api でターゲット限定)
# GAP-200: INSTALL_LOCALRAG=1 のときだけ localrag extra を足す。
RUN EXTRA=""; \
    if [ "$INSTALL_LOCALRAG" = "1" ]; then EXTRA="--extra localrag"; fi; \
    uv sync --frozen --no-install-project --package=atelier-api --no-dev $EXTRA || \
    uv sync --no-install-project --package=atelier-api --no-dev $EXTRA

# 残りの app コードをコピー
COPY apps/api/ ./apps/api/

# editable install で apps/api 本体を入れる
RUN EXTRA=""; \
    if [ "$INSTALL_LOCALRAG" = "1" ]; then EXTRA="--extra localrag"; fi; \
    uv sync --frozen --package=atelier-api --no-dev $EXTRA || \
    uv sync --package=atelier-api --no-dev $EXTRA

# GAP-200: モデルをビルド時に取り込む。実行時に DL させると
# 「最初の 1 人だけ数分待たされる」「ディスクが無くて静かに失敗する」になる。
# INSTALL_LOCALRAG=0 でも空ディレクトリは必ず作る (次段の COPY を成立させる)。
ENV ATELIER_MODEL_CACHE=/app/.models
RUN mkdir -p /app/.models && \
    if [ "$INSTALL_LOCALRAG" = "1" ]; then \
      .venv/bin/python apps/api/scripts/prefetch_models.py; \
    fi

# ─── Stage 2: runtime ─ slim な実行イメージ ──────────────────────
FROM python:3.12-slim-bookworm AS runtime
ARG INSTALL_LOCALRAG

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH" \
    PORT=8000

# GAP-200: 「このイメージがサーバー実行に対応しているか」を実行時に読めるようにする。
# 画面・ヘルスチェックはこの値を見て「入っていない」と正直に表示する。
ENV ATELIER_SERVER_AI_BUNDLED=${INSTALL_LOCALRAG} \
    ATELIER_MODEL_CACHE=/app/.models

# 非 root ユーザーで実行 (Fly.io security best practice)
RUN groupadd -r atelier && useradd -r -g atelier -d /app -s /sbin/nologin atelier

WORKDIR /app

# builder から venv + app コードをコピー
COPY --from=builder --chown=atelier:atelier /app/.venv /app/.venv
COPY --from=builder --chown=atelier:atelier /app/apps/api /app/apps/api
# GAP-200: ビルド時に取り込んだモデル (INSTALL_LOCALRAG=0 なら空)
COPY --from=builder --chown=atelier:atelier /app/.models /app/.models

USER atelier

EXPOSE 8000

# Fly.io healthcheck (fly.toml で /health 設定済)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3).status==200 else 1)"

# uvicorn 単 worker (asyncio で並列処理、複数 worker は VM scale で対応)
CMD ["uvicorn", "apps.api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
