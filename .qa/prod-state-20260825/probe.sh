#!/usr/bin/env bash
# 本番が「今どの状態か」を外から実測する (読み取りのみ / 本番にデータを作らない)。
#
# 背景: deploy.yml は 2026-08-13 の経営者判断で push トリガーを無効化してあり
# (本番公開はまだ行わない)、Fly (API) は workflow_dispatch でしか出ない。
# 一方 Vercel (画面) は GitHub Integration が自動デプロイする設定と書かれていた。
# → **画面だけ新しく、API が古い** というズレが起きていないかを確かめる。
set -uo pipefail
API=${API:-https://atelier-api-eb.fly.dev}
WEB=${WEB:-https://atelier-web-coral.vercel.app}

hit() { # path method label
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -X "$2" "$API$1" \
         -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
  printf "  %-26s %-4s -> %-3s  %s\n" "$1" "$2" "$code" "$3"
}
page() { # path label
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "$WEB$1")
  printf "  %-26s      -> %-3s  %s\n" "$1" "$code" "$2"
}

echo "== 実測日時: $(date -u '+%Y-%m-%d %H:%M UTC') =="
echo
echo "[1] API — 7/18 以降に足した口が在るか (401/403/422=在る / 404=無い)"
hit /auth/signout   POST "GAP-209 (2026-08-25)"
hit /billing/portal POST "GAP-208 (2026-08-22) 解約導線"
hit /me/consents    GET  "GAP-206 (2026-08-22) 再同意"
hit /admin/health   GET  "GAP-182 (8月上旬) 運営ヘルス"
hit /bridge/sessions POST "GAP-134 (7月下旬) Bridge 経路"
echo "  --- 対照 (7/18 時点で在った) ---"
hit /auth/signin    POST "6月から在る"
hit /health         GET  "最初から在る"
echo
echo "[2] 画面 — 生死と、7/18 以降に足したものが在るか"
page /signin      "公開ページ"
page /robots.txt  "GAP-204 (2026-08-21) で追加。404 の HTML が返るなら未反映"
echo
echo "[3] 画面 — サイドバーの項目 (テンプレートは GAP-154 = 8月に追加)"
curl -s --max-time 25 "$WEB/tokushoho" \
  | grep -oE '<span>[^<]+</span>' | sed 's/<[^>]*>//g' | head -12 | tr '\n' ' '
echo; echo
echo "[4] 公開されている法務ページの中身 (認証不要 = 誰でも読める)"
for p in tokushoho terms privacy; do
  echo "  --- /$p ---"
  curl -s --max-time 25 "$WEB/$p" | python3 -c "
import re,sys,html
t=re.sub(r'<script.*?</script>','',sys.stdin.read(),flags=re.S)
t=html.unescape(re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',t))).strip()
i=t.find('メインコンテンツへスキップ')
print('   ', t[i:i+520] if i>=0 else t[:520])
"
done
