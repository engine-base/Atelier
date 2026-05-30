#!/usr/bin/env bash
# T-I-11: Atelier Bridge macOS .dmg 配布ビルドスクリプト (signed & notarized)。
# T-I-11 補強: electron-builder で実走するように本配線。
#
# 前提:
#   - APPLE_ID, APPLE_ID_PASSWORD, APPLE_TEAM_ID, CSC_LINK, CSC_KEY_PASSWORD が
#     環境変数で設定済 (signing + notarization 用)。
#   - 本コンテナは Linux なので macOS build は実行不可。
#     macOS host または GitHub Actions macos-latest runner 上で実行する。
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

if ! command -v node >/dev/null 2>&1; then
  echo "::error::node not found" >&2
  exit 1
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "::warning::This script must run on macOS for code signing & notarization." >&2
fi

# TypeScript -> dist/
pnpm -F @atelier/bridge build

# electron-builder で macOS dmg を生成
if [ "$NO_NOTARIZE" -eq 1 ]; then
  CSC_IDENTITY_AUTO_DISCOVERY=false \
    pnpm -F @atelier/bridge exec electron-builder --mac dmg --publish=never
else
  pnpm -F @atelier/bridge exec electron-builder --mac dmg --publish=never
fi

OUT="apps/bridge/out"
ls -lh "$OUT"/*.dmg 2>/dev/null || {
  echo "::error::dmg not found in $OUT" >&2
  exit 1
}

if [ "$NO_NOTARIZE" -eq 0 ] && [ "$(uname -s)" = "Darwin" ]; then
  echo "→ Notarization step"
  # electron-builder の afterSign hook で notarytool を呼ぶ場合は build.afterSign に設定
fi

echo "✓ macOS dmg build completed"
