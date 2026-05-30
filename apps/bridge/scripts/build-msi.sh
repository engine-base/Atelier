#!/usr/bin/env bash
# T-I-12: Atelier Bridge Windows .msi (NSIS) 配布ビルドスクリプト。
# T-I-12 補強: electron-builder で実走するように本配線。
#
# 前提:
#   - CSC_LINK, CSC_KEY_PASSWORD (windows code signing) 環境変数。
#   - Windows host または GitHub Actions windows-latest runner 上で実行する
#     (Linux/macOS から cross-build も可能だが wine が必要)。
#
# Usage:
#   ./apps/bridge/scripts/build-msi.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "→ Building Atelier Bridge Windows .msi (NSIS)"

if ! command -v node >/dev/null 2>&1; then
  echo "::error::node not found" >&2
  exit 1
fi

# TypeScript -> dist/
pnpm -F @atelier/bridge build

# electron-builder で windows nsis を生成 (.exe; build target を msi にしたい場合は package.json で nsis -> msi 切替)
pnpm -F @atelier/bridge exec electron-builder --win nsis --publish=never

OUT="apps/bridge/out"
ls -lh "$OUT"/*.exe 2>/dev/null || {
  echo "::error::installer .exe not found in $OUT" >&2
  exit 1
}

echo "✓ Windows installer build completed"
