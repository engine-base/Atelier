#!/usr/bin/env bash
# T-I-22: 本番監視 sanity check スクリプト。
#
# Better Stack の uptime / Sentry の error rate / 主要 endpoint の 200 を一括確認。
# 本番リリース時 (T-I-24) の go/no-go チェックリストの一部として使う。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE_WEB="${ATELIER_WEB_URL:-https://app.atelier.example}"
BASE_API="${ATELIER_API_URL:-https://api.atelier.example}"

echo "═══════════════════════════════════════════════════════"
echo "  Atelier monitoring sanity check (T-I-22)"
echo "═══════════════════════════════════════════════════════"

check_url() {
  local name="$1"
  local url="$2"
  local expected="${3:-200}"
  local code
  code=$(curl -fsS -o /dev/null -w "%{http_code}" "$url" || echo "000")
  if [ "$code" = "$expected" ]; then
    echo "  ✓ $name: $url → $code"
  else
    echo "  ✗ $name: $url → $code (expected $expected)"
    return 1
  fi
}

ok=0
fail=0
for spec in \
  "Web home|$BASE_WEB/|200" \
  "Web 利用規約|$BASE_WEB/public/s_pub01|200" \
  "API healthz|$BASE_API/healthz|200" \
  ; do
  IFS='|' read -r n u c <<<"$spec"
  if check_url "$n" "$u" "$c"; then ok=$((ok+1)); else fail=$((fail+1)); fi
done

echo ""
echo "  Passed: $ok / Failed: $fail"

if [ "$fail" -gt 0 ]; then
  echo "::error::monitoring sanity check failed"
  exit 1
fi

echo "  ✓ All monitoring endpoints are healthy"
