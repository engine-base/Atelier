#!/usr/bin/env bash
# T-I-23: 本番ロールバック自動化スクリプト。
#
# 直前の Vercel deployment + Fly.io release に戻し、cache を purge する。
# 詳細手順は docs/rollback-runbook.md を参照。
#
# Usage:
#   ./scripts/rollback.sh [--dry-run]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

echo "═══════════════════════════════════════════════════════"
echo "  Atelier ROLLBACK runner (T-I-23)"
echo "  dry-run: $DRY_RUN"
echo "═══════════════════════════════════════════════════════"

echo "→ 1) Vercel: 直前の prod deployment を promote"
if command -v vercel >/dev/null 2>&1; then
  PREV_URL=$(vercel ls --prod --json 2>/dev/null | head -200 | grep -m1 -oE '"url":"[^"]+"' | sed 's/"url":"//; s/"$//' || echo "")
  if [ -n "$PREV_URL" ]; then
    run vercel rollback "https://$PREV_URL"
  else
    echo "  ::warning::Vercel prev deployment 取得失敗。手動で実施が必要"
  fi
else
  echo "  ::warning::vercel CLI 未インストール"
fi

echo "→ 2) Fly.io: 1 つ前の release を redeploy"
if command -v flyctl >/dev/null 2>&1; then
  PREV_TAG=$(flyctl releases --app atelier-api 2>/dev/null | awk 'NR==3 {print $2}' || echo "")
  if [ -n "$PREV_TAG" ]; then
    run flyctl deploy --app atelier-api --image "registry.fly.io/atelier-api:$PREV_TAG"
  else
    echo "  ::warning::Fly.io prev release 取得失敗。手動で実施が必要"
  fi
else
  echo "  ::warning::flyctl 未インストール"
fi

echo "→ 3) Cloudflare cache purge"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ZONE_ID:-}" ]; then
  run curl -X POST \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '{"purge_everything":true}' \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache"
else
  echo "  ::warning::CLOUDFLARE_API_TOKEN / ZONE_ID が未設定"
fi

echo "→ 4) Slack #alerts に通知"
if [ -n "${SLACK_ALERTS_WEBHOOK:-}" ]; then
  run curl -X POST -H "Content-Type: application/json" \
    --data '{"text":"🚨 本番 rollback が完了しました (T-I-23). 詳細は postmortem を確認してください。"}' \
    "$SLACK_ALERTS_WEBHOOK"
else
  echo "  ::warning::SLACK_ALERTS_WEBHOOK が未設定"
fi

echo "✓ rollback 手順完了"
echo "  ⚠ ポストモーテム作成を 24h 以内に: 09_dispatch/postmortems/"
