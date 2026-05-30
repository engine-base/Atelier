#!/usr/bin/env bash
# T-I-11: Atelier Bridge macOS .dmg 配布ビルドスクリプト (signed & notarized)。
#
# 前提:
#   - APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID, CSC_LINK, CSC_KEY_PASSWORD が
#     環境変数で設定済 (signing + notarization 用)。
#   - Vibeyard fork (electron-forge) 取込後に electron-forge make --target=dmg
#     に置き換える。本スクリプトはスケルトンとして配置。
#
# Usage:
#   ./apps/bridge/scripts/build-dmg.sh [--no-notarize]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

NO_NOTARIZE=0
for arg in "$@"; do
  case "$arg" in
    --no-notarize) NO_NOTARIZE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

echo "→ Building Atelier Bridge macOS .dmg"
echo "  ROOT: $ROOT"

# placeholder: 本実装は Vibeyard fork 取込後に electron-forge へ置換
if ! command -v node >/dev/null 2>&1; then
  echo "::error::node not found" >&2
  exit 1
fi

# 想定: pnpm -F @atelier/bridge run dist:mac で electron-builder が走る
# pnpm -F @atelier/bridge run dist:mac
echo "::notice::placeholder build (Vibeyard fork pending). スクリプトは scope を予約。"

if [ "$NO_NOTARIZE" -eq 0 ]; then
  echo "→ Notarization step (placeholder)"
  # xcrun notarytool submit ... --wait
fi

echo "✓ macOS dmg build completed (placeholder)"
