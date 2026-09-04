#!/usr/bin/env bash
# GAP-206 実 e2e: **検査対象への登録漏れ**を、実際に漏らして確かめる。
#
# GAP-204 で「画面側に中身が混ざっていないか」を機械検査するようにしたが、
# 検査対象の一覧 (SERVER_ONLY_SOURCES) は **手で書く一覧**だった。
# そのため新しくプロンプトを持つファイルを足しても、一覧に書き忘れると
# **そのファイルは丸ごと検査を素通り**する。実際に 4 ファイル漏れていた。
#
# ここでは「登録漏れを検知する」だけでなく、**登録した瞬間に本当に守られる**
# ところまで一本で通す。終わったら必ず元へ戻す。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
CHECK="python3 scripts/ci/check-client-leak.py"
CHECKER="scripts/ci/check-client-leak.py"
PLANTED_PY="apps/api/src/services/_gap206_planted_prompt.py"
PLANTED_JS="apps/web/.next/static/chunks/_gap206-planted-leak.js"
BACKUP="/tmp/gap206-checker.bak"
FAILURES=0

ok() { echo "  OK   $1"; }
ng() { echo "  NG   $1"; FAILURES=$((FAILURES + 1)); }

cleanup() {
  rm -f "$PLANTED_PY" "$PLANTED_JS"
  [ -f "$BACKUP" ] && cp "$BACKUP" "$CHECKER" && rm -f "$BACKUP"
  find apps/api/src/services -name '_gap206_planted_prompt*' -delete 2>/dev/null
}
trap cleanup EXIT

# 仕込むプロンプト (実在のものは使わない — この e2e 専用の作り物)
LEAK='あなたは架空の検証専用 AI 社員です。この文はテストのために置かれています'

echo "[0] 前提"
if [ ! -d "apps/web/.next/static" ]; then
  echo "  NG   apps/web/.next/static がありません。先に build してください。"
  exit 1
fi
ok "画面側のビルド成果物がある"
cp "$CHECKER" "$BACKUP"

echo
echo "[1] 今の状態は PASS すること (土台)"
if $CHECK > /tmp/gap206-before.log 2>&1; then
  ok "現状は登録漏れも漏洩も無い"
else
  ng "先に現状を PASS させてください:"; sed 's/^/       /' /tmp/gap206-before.log; exit 1
fi

echo
echo "[2] **プロンプトを持つ新ファイルを足す** → 登録漏れとして落ちること"
cat > "$PLANTED_PY" <<PY
"""GAP-206 e2e 用の仕込みファイル (自動で消えます)。"""

SYSTEM_PROMPT = "${LEAK}。"
PY
if $CHECK > /tmp/gap206-unregistered.log 2>&1; then
  ng "**プロンプトを持つファイルを足したのに検査が通ってしまった** (登録漏れを見逃す)"
else
  ok "登録漏れとして落ちた"
  grep -q "_gap206_planted_prompt.py" /tmp/gap206-unregistered.log \
    && ok "どのファイルが漏れているか名前が出ている" \
    || ng "ファイル名が出ていない (どこを直せばいいか分からない)"
  grep -q "SERVER_ONLY_SOURCES" /tmp/gap206-unregistered.log \
    && ok "直し方 (どこに足すか) が出ている" \
    || ng "直し方が出ていない"
fi

echo
echo "[3] 登録したら PASS すること (登録すれば止まらない)"
python3 - "$CHECKER" "$PLANTED_PY" <<'PY'
import sys, pathlib
p = pathlib.Path(sys.argv[1]); s = p.read_text(encoding="utf-8")
s = s.replace('SERVER_ONLY_SOURCES = [\n', f'SERVER_ONLY_SOURCES = [\n    "{sys.argv[2]}",\n', 1)
p.write_text(s, encoding="utf-8")
PY
if $CHECK > /tmp/gap206-registered.log 2>&1; then
  ok "登録したら通った"
else
  ng "登録しても落ちる:"; sed 's/^/       /' /tmp/gap206-registered.log
fi

echo
echo "[4] **登録した中身が本当に守られる**こと (登録が飾りでない)"
printf 'export const x=%s;\n' "\"$LEAK\"" > "$PLANTED_JS"
if $CHECK > /tmp/gap206-leak.log 2>&1; then
  ng "**登録済みファイルの文言を画面側へ埋めたのに通ってしまった** (登録が効いていない)"
else
  ok "登録したファイルの文言が画面側に出たら落ちた"
  grep -q "_gap206_planted_prompt.py" /tmp/gap206-leak.log \
    && ok "出どころのファイル名が出ている" \
    || ng "出どころが出ていない"
fi
rm -f "$PLANTED_JS"

echo
echo "[5] 登録だけ残してファイルを消したら、**古い登録**として落ちること"
rm -f "$PLANTED_PY"
if $CHECK > /tmp/gap206-stale.log 2>&1; then
  ng "実在しないファイルが登録されたまま通ってしまった (一覧が腐る)"
else
  ok "実在しない登録を検知して落ちた"
fi

echo
echo "[6] 後片付けしたら元どおり PASS すること"
cleanup
if $CHECK > /tmp/gap206-after.log 2>&1; then
  ok "元どおり PASS (仕込みが残っていない)"
else
  ng "仕込みが残っている:"; sed 's/^/       /' /tmp/gap206-after.log
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "FAIL: $FAILURES 件"
  exit 1
fi
echo "PASS: 登録漏れは落ちる / 登録すれば本当に守られる / 古い登録も落ちる"
