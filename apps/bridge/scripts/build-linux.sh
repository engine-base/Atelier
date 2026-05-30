#!/usr/bin/env bash
# T-I-12: Atelier Bridge Linux 配布ビルド (AppImage + .deb)。
# T-I-12 補強: electron-builder で実走するように本配線。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "→ Building Atelier Bridge Linux (AppImage + .deb)"

if ! command -v node >/dev/null 2>&1; then
  echo "::error::node not found" >&2
  exit 1
fi

# TypeScript -> dist/
pnpm -F @atelier/bridge build

# electron-builder で linux 配布物を生成
pnpm -F @atelier/bridge exec electron-builder --linux AppImage deb --publish=never

OUT="apps/bridge/out"
echo "→ Generated artifacts:"
ls -lh "$OUT"/*.AppImage "$OUT"/*.deb 2>/dev/null || {
  echo "::error::AppImage/.deb not found in $OUT" >&2
  exit 1
}

echo "✓ Linux build completed"
