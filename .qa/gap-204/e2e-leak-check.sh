#!/usr/bin/env bash
# GAP-204 実 e2e: 「漏洩検査が本当に漏洩を捕まえるか」を実際に仕込んで確かめる。
#
# 検査スクリプトが「PASS した」だけでは意味がない (何も見ていなくても PASS する)。
# ここでは **本物のプロンプト文を画面側のビルド成果物へ実際に埋め込み**、
# 検査が落ちることを確かめる。終わったら必ず元へ戻す。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CHECK="python3 scripts/ci/check-client-leak.py"
STATIC="apps/web/.next/static"
PLANTED="$STATIC/chunks/_gap204-planted-leak.js"
FAILURES=0

ok() { echo "  OK   $1"; }
ng() { echo "  NG   $1"; FAILURES=$((FAILURES + 1)); }

cleanup() {
  rm -f "$PLANTED"
  rm -f "$STATIC/_gap204-planted.js.map"
}
trap cleanup EXIT

echo "[0] 前提: ビルド成果物があること"
if [ ! -d "$STATIC" ]; then
  echo "  NG   $STATIC がありません。先に pnpm --filter @atelier/web build を実行してください。"
  exit 1
fi
ok "画面側のビルド成果物がある ($(find "$STATIC" -name '*.js' | wc -l) ファイル)"

echo
echo "[1] 今の状態は PASS すること（土台の確認）"
if $CHECK > /tmp/gap204-before.log 2>&1; then
  ok "現状は漏洩なし"
else
  ng "先に現状を PASS させてください:"; sed 's/^/       /' /tmp/gap204-before.log
  exit 1
fi

echo
echo "[2] **本物のプロンプト文を画面側へ実際に埋め込む** → 検査が落ちること"
# 出どころ: apps/api/src/services/sales_docs/generate.py の システムプロンプト冒頭
LEAK='あなたは開発案件管理 SaaS の営業 AI「トニー」です。'
printf 'export const x=%s;\n' "\"$LEAK\"" > "$PLANTED"
if $CHECK > /tmp/gap204-planted.log 2>&1; then
  ng "**プロンプトを埋め込んだのに検査が通ってしまった**（検査が機能していない）"
else
  ok "埋め込んだプロンプトを検知して落ちた"
  if grep -q "トニー" /tmp/gap204-planted.log; then
    ok "どの文言が漏れたか報告に出ている"
  else
    ng "漏れた文言が報告に出ていない（原因が分からない）"
  fi
  if grep -q "sales_docs/generate.py" /tmp/gap204-planted.log; then
    ok "出どころのファイル名も報告に出ている"
  else
    ng "出どころが報告に出ていない"
  fi
fi
rm -f "$PLANTED"

echo
echo "[3] \\uXXXX に逃がして埋め込んでも検知すること（難読化で素通りしない）"
python3 - "$PLANTED" <<'PY'
import sys, pathlib
leak = "あなたは開発案件管理 SaaS の営業 AI「トニー」です。"
escaped = "".join(f"\\u{ord(c):04x}" if ord(c) > 127 else c for c in leak)
pathlib.Path(sys.argv[1]).write_text(f'export const x="{escaped}";\n', encoding="utf-8")
PY
if $CHECK > /tmp/gap204-escaped.log 2>&1; then
  ng "**\\uXXXX に逃がすと素通りした**（バンドラの出力形式で検知漏れする）"
else
  ok "\\uXXXX 形式でも検知した"
fi
rm -f "$PLANTED"

echo
echo "[4] ソースマップが配られていたら落ちること"
echo '{"version":3,"sources":["../app/page.tsx"]}' > "$STATIC/_gap204-planted.js.map"
if $CHECK > /tmp/gap204-map.log 2>&1; then
  ng "**ソースマップを置いたのに検査が通ってしまった**"
else
  ok "配られたソースマップを検知して落ちた"
  grep -q "ソースマップ" /tmp/gap204-map.log && ok "理由が日本語で出ている" || ng "理由が出ていない"
fi
rm -f "$STATIC/_gap204-planted.js.map"

echo
echo "[5] 後片付けしたら元どおり PASS すること"
if $CHECK > /tmp/gap204-after.log 2>&1; then
  ok "元どおり PASS（仕込みが残っていない）"
else
  ng "仕込みが残っている:"; sed 's/^/       /' /tmp/gap204-after.log
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "FAIL: $FAILURES 件"
  exit 1
fi
echo "PASS: 検査は実際の漏洩（素の日本語 / \\uXXXX / ソースマップ）を捕まえる"
