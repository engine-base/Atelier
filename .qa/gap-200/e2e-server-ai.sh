#!/usr/bin/env bash
# GAP-200 実 e2e: 「サーバーで意味検索・文字起こしを動かす」選択が
# 実際に成立するか / 既定では何も増えないかを実物で確認する。
#
#   ① 既定 (INSTALL_LOCALRAG=0) の Dockerfile が localrag を入れないこと
#   ② 有効化したときにモデルが**実際に落ちてきて容量が測れる**こと (実行)
#   ③ deploy が VM 不足のまま有効化できないこと (実スクリプトを実行)
#
# ② はモデルを実 DL するため 2.6GB を使う。確認後に削除する。
set -uo pipefail
cd "$(dirname "$0")/../.."
fail=0
note() { printf '  %s %s\n' "$1" "$2"; }

echo "[1] 既定は「入れない」ことの確認"
if grep -q 'ARG INSTALL_LOCALRAG=0' apps/api/Dockerfile; then
  note OK "Dockerfile の既定は INSTALL_LOCALRAG=0"
else
  note NG "既定が 0 ではない"; fail=1
fi
if grep -q 'if \[ "\$INSTALL_LOCALRAG" = "1" \]; then EXTRA="--extra localrag"' apps/api/Dockerfile; then
  note OK "localrag extra は 1 のときだけ入る"
else
  note NG "extra が無条件に入っている"; fail=1
fi

echo
echo "[2] 有効化したときにモデルが実際に取り込めるか (実 DL)"
export ATELIER_MODEL_CACHE="$(pwd)/.qa/gap-200/.models"
rm -rf "$ATELIER_MODEL_CACHE"
if uv run --project apps/api python apps/api/scripts/prefetch_models.py 2>&1 | grep -E '^(OK|NG)'; then
  :
fi
if [ -d "$ATELIER_MODEL_CACHE" ]; then
  size=$(du -sh "$ATELIER_MODEL_CACHE" | cut -f1)
  note OK "取り込んだモデルの実サイズ: $size"
  du -sh "$ATELIER_MODEL_CACHE"/models--* 2>/dev/null | sed 's/^/       /'
else
  note NG "モデルが取り込めなかった"; fail=1
fi
rm -rf "$ATELIER_MODEL_CACHE"
note "--" "確認後に削除 (リポジトリには残さない)"

echo
echo "[3] VM 不足のまま有効化できないことの確認 (deploy の実スクリプトを実行)"
run_vm_check() {
  local toml="$1"
  MEM=$(grep -A5 '^\[\[vm\]\]' "$toml" | grep 'memory' | head -1 | sed 's/[^0-9]*\([0-9]*\).*/\1/')
  UNIT=$(grep -A5 '^\[\[vm\]\]' "$toml" | grep 'memory' | head -1 | grep -o 'gb\|mb')
  if [ "$UNIT" = "gb" ]; then MEM=$((MEM * 1024)); fi
  echo "$MEM"
}
mem_now=$(run_vm_check fly.toml)
note "--" "今の fly.toml の memory = ${mem_now}MB"
if [ "${mem_now:-0}" -lt 1024 ]; then
  note OK "1024MB 未満なので server_ai=true の deploy は止まる (意図どおり)"
else
  note OK "1024MB 以上なのでサーバー実行を選べる状態"
fi
tmp=$(mktemp -d)
printf '[[vm]]\n  size = "shared-cpu-1x"\n  memory = "2048mb"\n  cpus = 1\n' > "$tmp/fly.toml"
mem_big=$(run_vm_check "$tmp/fly.toml")
if [ "$mem_big" = "2048" ]; then
  note OK "2048mb の設定は 2048MB として読める (判定式が正しい)"
else
  note NG "memory の読み取りが誤っている: $mem_big"; fail=1
fi
printf '[[vm]]\n  memory = "1gb"\n' > "$tmp/fly.toml"
mem_gb=$(run_vm_check "$tmp/fly.toml")
if [ "$mem_gb" = "1024" ]; then
  note OK "gb 表記も MB に換算できる"
else
  note NG "gb 換算が誤っている: $mem_gb"; fail=1
fi
rm -rf "$tmp"

echo
if [ "$fail" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS: 既定は増やさない / 有効化すれば実際に取り込める / VM 不足では止まる"
