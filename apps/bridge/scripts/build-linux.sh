#!/usr/bin/env bash
# T-I-12: Atelier Bridge Linux 配布ビルド (AppImage + .deb)。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"

echo "→ Building Atelier Bridge Linux (AppImage + .deb)"

if ! command -v node >/dev/null 2>&1; then
  echo "::error::node not found" >&2
  exit 1
fi

# placeholder
echo "::notice::placeholder build (Vibeyard fork pending)."

echo "✓ Linux build completed (placeholder)"
