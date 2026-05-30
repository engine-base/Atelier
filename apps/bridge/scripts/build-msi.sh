#!/usr/bin/env bash
# T-I-12: Atelier Bridge Windows .msi 配布ビルドスクリプト。
#
# 前提:
#   - CSC_LINK, CSC_KEY_PASSWORD (windows code signing) 環境変数。
#   - Vibeyard fork 取込後に electron-forge make --target=msi (もしくは
#     squirrel.windows) に置き換える。
#
# Usage:
#   ./apps/bridge/scripts/build-msi.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "→ Building Atelier Bridge Windows .msi"

if ! command -v node >/dev/null 2>&1; then
  echo "::error::node not found" >&2
  exit 1
fi

# placeholder
echo "::notice::placeholder build (Vibeyard fork pending)."

echo "✓ Windows msi build completed (placeholder)"
