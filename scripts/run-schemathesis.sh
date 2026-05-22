#!/usr/bin/env bash
# Schemathesis contract test runner.
#
# 07_api_design/openapi.yaml を契約として、apps/api (FastAPI) 実装が
# 契約に違反しないことを property-based に検証する。
#
# Usage: ./scripts/run-schemathesis.sh [--examples 200]
#
# 環境変数:
#   PORT           default 8765
#   EXAMPLES       hypothesis max examples (default 200)
#   INCLUDE_REGEX  --include-path-regex の正規表現 (default '^/health$')
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8765}"
EXAMPLES="${EXAMPLES:-200}"
INCLUDE_REGEX="${INCLUDE_REGEX:-^/health$}"
OPENAPI="07_api_design/openapi.yaml"

if [ ! -f "$OPENAPI" ]; then
  echo "::error::$OPENAPI not found" >&2
  exit 1
fi

if [ ! -f apps/api/main.py ]; then
  echo "::error::apps/api/main.py not found" >&2
  exit 1
fi

# uv sync + schemathesis 用追加 deps
uv sync --all-packages --all-extras
uv pip install schemathesis==4.0.0

# uvicorn を background で boot
# subshell 全体を & で background 化することで $! が正しく PID を取得できる
echo "→ booting uvicorn on 127.0.0.1:${PORT}"
( cd apps/api && uv run uvicorn main:app --host 127.0.0.1 --port "$PORT" ) >/tmp/uvicorn.log 2>&1 &
UVICORN_PID="$!"
trap 'kill "${UVICORN_PID}" 2>/dev/null || true' EXIT

# health check
echo "→ waiting for health endpoint"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "  API is up after ${i}s"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "::error::API failed to boot within 30s" >&2
    cat /tmp/uvicorn.log >&2 || true
    exit 1
  fi
  sleep 1
done

# Schemathesis 実行
echo "→ schemathesis run (examples=${EXAMPLES}, include='${INCLUDE_REGEX}')"
uv run schemathesis run \
  "$OPENAPI" \
  --url "http://127.0.0.1:${PORT}" \
  --include-path-regex "$INCLUDE_REGEX" \
  --checks not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance,negative_data_rejection \
  --hypothesis-max-examples "$EXAMPLES" \
  --hypothesis-deadline 5000 \
  --workers 2

echo "✓ Schemathesis PASS"
