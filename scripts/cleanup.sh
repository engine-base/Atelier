#!/usr/bin/env bash
# T-I-19: dead code / unused dep / unused export を検出する cleanup runner。
#
# 使うツール:
#   - knip: 未使用 file / export / dep を検出 (TS/JS workspace 横断)
#   - depcheck: 各 workspace の未使用 dep を検出
#   - ts-prune: TS unused export を検出
#
# 本スクリプトはレポート出力のみ。CI gate には組み込まず、開発者が定期的に
# 走らせる nightly job 想定。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "═══════════════════════════════════════════════════════"
echo "  Atelier cleanup runner (T-I-19)"
echo "═══════════════════════════════════════════════════════"

echo "→ knip (未使用 export / file / dep)"
npx --yes knip@5 --no-progress || true

echo "→ depcheck (workspace 別 未使用 dep)"
for ws in apps/web apps/api packages/api-types packages/api-client packages/shared; do
  if [ -d "$ws" ] && [ -f "$ws/package.json" ]; then
    echo "  · $ws"
    (cd "$ws" && npx --yes depcheck@1 --quiet) || true
  fi
done

echo "→ ts-prune (TS unused exports)"
npx --yes ts-prune@0 -p apps/web/tsconfig.json --ignore '\.test\.|\.spec\.' || true

echo "✓ cleanup scan 完了 (修正は手動で適用してください)"
