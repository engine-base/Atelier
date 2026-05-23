# syntax=docker/dockerfile:1.7
# Atelier API — production Docker image (T-F-06 follow-up)
#
# selected-stack.json#python_runtime = "Python 3.12 + uv (Astral)"
# Fly.io NRT で uvicorn を 1 worker で起動。Inngest worker は別 process group
# (T-F-13) で同居予定。

# ─── Stage 1: builder ─ uv で deps を install ───────────────────
FROM python:3.12-slim-bookworm AS builder

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
RUN uv sync --frozen --no-install-project --package=atelier-api --no-dev || \
    uv sync --no-install-project --package=atelier-api --no-dev

# 残りの app コードをコピー
COPY apps/api/ ./apps/api/

# editable install で apps/api 本体を入れる
RUN uv sync --frozen --package=atelier-api --no-dev || \
    uv sync --package=atelier-api --no-dev

# ─── Stage 2: runtime ─ slim な実行イメージ ──────────────────────
FROM python:3.12-slim-bookworm AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH" \
    PORT=8000

# 非 root ユーザーで実行 (Fly.io security best practice)
RUN groupadd -r atelier && useradd -r -g atelier -d /app -s /sbin/nologin atelier

WORKDIR /app

# builder から venv + app コードをコピー
COPY --from=builder --chown=atelier:atelier /app/.venv /app/.venv
COPY --from=builder --chown=atelier:atelier /app/apps/api /app/apps/api

USER atelier

EXPOSE 8000

# Fly.io healthcheck (fly.toml で /health 設定済)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3).status==200 else 1)"

# uvicorn 単 worker (asyncio で並列処理、複数 worker は VM scale で対応)
CMD ["uvicorn", "apps.api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
