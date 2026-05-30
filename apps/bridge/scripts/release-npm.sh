#!/usr/bin/env bash
# T-I-12: Atelier Bridge npm package 公開スクリプト。
#
# Bridge の MCP server 側 (node 単独動作版) を npm パッケージとして配布する。
# Electron 版とは別の SKU。
#
# 前提:
#   - NPM_TOKEN 環境変数 (CI で secrets から注入)。
#   - apps/bridge/package.json の version が main で更新済。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT/apps/bridge"

if [ -z "${NPM_TOKEN:-}" ]; then
  echo "::error::NPM_TOKEN not set" >&2
  exit 1
fi

# placeholder
echo "::notice::placeholder release (Vibeyard fork pending). 本番では:"
echo "  pnpm -F @atelier/bridge build"
echo "  npm publish --access public --provenance"

echo "✓ release-npm completed (placeholder)"
