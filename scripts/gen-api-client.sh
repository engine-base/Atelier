#!/usr/bin/env bash
# T-US-04: API client 型生成パイプライン
#
# 信頼源: 07_api_design/openapi.yaml → packages/api-types/src/openapi.ts (T-F-25 が生成)
# このスクリプトは sync-types.sh と協調する:
#   1. sync-types.sh が openapi.yaml → openapi.ts を生成
#   2. 本スクリプトはその出力を packages/api-client が消費していることを健全性チェック
#
# CI Gate #7 (type drift) は sync-types.sh の出力に対して動くため、本スクリプトは
# 「api-client の tsc が通る」ことを保証する補助ツール。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

API_TYPES="packages/api-types/src/openapi.ts"
API_CLIENT="packages/api-client/src/index.ts"

if [ ! -f "$API_TYPES" ]; then
  echo "::error::$API_TYPES not found. Run scripts/sync-types.sh first." >&2
  exit 1
fi
if [ ! -f "$API_CLIENT" ]; then
  echo "::error::$API_CLIENT not found." >&2
  exit 1
fi

echo "→ regenerating @atelier/api-types via sync-types.sh"
"$ROOT/scripts/sync-types.sh"

echo "→ type-checking @atelier/api-client"
pnpm --filter @atelier/api-client run type-check

echo "✓ api-client is in sync with openapi.yaml"
