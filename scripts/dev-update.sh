#!/usr/bin/env bash
# ローカル開発環境を main の最新へ安全に追従させる 1 コマンド (macOS / Linux)。
#
#   bash scripts/dev-update.sh
#
# これ 1 本で以下を必ずこの順で行う (手順の抜け漏れを構造的に不可能にする):
#   1. git pull (main)
#   2. DB 起動確認 + 全 migration + seed の適用 (dev-bootstrap.sh — 冪等)
#   3. API 再起動 (設定は apps/api/.env から読む — export 不要)
#   4. web の依存更新 + クリーンビルド + 再起動 (チャンク不整合を防ぐため .next を消す)
#
# 2026-08-17 制定: 「pull はしたが migration を流し忘れて 500」
# 「旧サーバーが新ビルドを掴んで CSS 崩れ」が繰り返されたための恒久対策。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== [1/4] git pull =="
git pull origin main

echo "== [2/4] DB (migration + seed — 冪等) =="
if [[ "$(uname)" == "Darwin" ]]; then
  # Homebrew PostgreSQL が停止していたら起動 (バージョン違いは既起動なら no-op)
  brew services start postgresql@17 >/dev/null 2>&1 || true
fi
bash scripts/dev-bootstrap.sh | tail -4

echo "== [3/4] API 再起動 =="
# uv の PATH (公式インストーラ配置) を通す
[ -f "$HOME/.local/bin/env" ] && source "$HOME/.local/bin/env"
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
(cd apps/api && nohup uv run --no-sync uvicorn main:app --host 127.0.0.1 --port 8000 > /tmp/atelier-api.log 2>&1 &)

echo "== [4/4] web クリーンビルド + 再起動 =="
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
(cd apps/web && rm -rf .next && pnpm install --silent && pnpm exec next build)
(cd apps/web && nohup pnpm exec next start -p 3000 > /tmp/atelier-web.log 2>&1 &)

sleep 4
echo "== 確認 =="
curl -s http://127.0.0.1:8000/health || { echo "API が起動していません → tail -20 /tmp/atelier-api.log"; exit 1; }
echo
# DB を実際に通るエンドポイントで疎通確認 (401 = DB まで届いている)
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8000/auth/signin \
  -H 'Content-Type: application/json' -d '{"email":"probe@example.com","password":"x"}')
if [ "$code" = "401" ] || [ "$code" = "400" ] || [ "$code" = "422" ]; then
  echo "DB 疎通: OK ($code)"
else
  echo "DB 疎通: NG ($code) → tail -20 /tmp/atelier-api.log を確認"
  exit 1
fi
echo "完了。http://localhost:3000 を Cmd+Shift+R で開き直してください。"
