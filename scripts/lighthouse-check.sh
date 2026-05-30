#!/usr/bin/env bash
# T-I-09 Lighthouse CWV (Core Web Vitals) check.
#
# Usage:
#   ./scripts/lighthouse-check.sh
#
# .lighthouserc.json で対象 URL と assertion thresholds を定義。
# CI gate としては categories:accessibility を error 扱い (>= 0.9 必須)、
# performance/best-practices/SEO は warn 扱い (PR は通すが alert)。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f .lighthouserc.json ]; then
  echo "::error::.lighthouserc.json not found" >&2
  exit 1
fi

# @lhci/cli を npx で起動 (workspace に追加せず使い捨て)
npx --yes @lhci/cli@0.14.0 autorun
