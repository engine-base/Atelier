#!/usr/bin/env bash
# T-F-44 回帰テスト: begin-task.sh の dispatch 出力 → TMP_DIR 抽出 (GAP-111)。
#
# 旧実装は `grep -oE '/tmp/atelier-dispatch-[^ ]+'` で「✓ Generated: <dir>/CLAUDE.md」に
# マッチし、TMP_DIR に '/CLAUDE.md' まで含めてしまうため必ず exit 4 していた。
#
# ここでは begin-task.sh を BEGIN_TASK_LIB_ONLY=1 で source し、実際の
# extract_dispatch_dir() を**実装そのまま**呼んで検証する (テスト用の再実装はしない)。
#
# usage: ./scripts/tests/test-begin-task-path.sh
# exit:  0 = 全 PASS / 1 = 1 件でも FAIL

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# shellcheck source=/dev/null
BEGIN_TASK_LIB_ONLY=1 . "$REPO_ROOT/scripts/begin-task.sh"

FAILURES=0
CASES=0

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  CASES=$((CASES + 1))
  if [ "$expected" = "$actual" ]; then
    echo "  ✓ $name"
  else
    echo "  ✗ $name" >&2
    echo "      expected: [$expected]" >&2
    echo "      actual:   [$actual]" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

echo "T-F-44: extract_dispatch_dir()"

# ── 1. 正常系: 実 dispatch 出力の形 ─────────────────────────────
REAL_OUTPUT='<stdin>:21: SyntaxWarning: invalid escape sequence
✓ Generated: /tmp/atelier-dispatch-T-X-01-ab12Cd/CLAUDE.md

次の手順：
  1. cd /Users/dev/Atelier'
assert_eq "実 dispatch 出力から dir だけを取り出す" \
  "/tmp/atelier-dispatch-T-X-01-ab12Cd" \
  "$(extract_dispatch_dir "$REAL_OUTPUT")"

assert_eq "1 行だけの出力でも取り出せる" \
  "/tmp/atelier-dispatch-T-F-44-6pMu9t" \
  "$(extract_dispatch_dir '✓ Generated: /tmp/atelier-dispatch-T-F-44-6pMu9t/CLAUDE.md')"

# 後続の手順書きにも同じ dir が現れるが、最初の 1 件だけを使う
MULTI_OUTPUT='✓ Generated: /tmp/atelier-dispatch-T-D-22-Zz99/CLAUDE.md
  3. cp /tmp/atelier-dispatch-T-D-22-Zz99/CLAUDE.md ./CLAUDE.md'
assert_eq "複数回出現しても 1 つの dir を返す" \
  "/tmp/atelier-dispatch-T-D-22-Zz99" \
  "$(extract_dispatch_dir "$MULTI_OUTPUT")"

# ── 2. 抽出結果が「ディレクトリ」であること (本バグの核心) ──────
RESULT="$(extract_dispatch_dir "$REAL_OUTPUT")"
ENDS_WITH_FILE=0
case "$RESULT" in
  */CLAUDE.md) ENDS_WITH_FILE=1 ;;
esac
assert_eq "末尾に /CLAUDE.md を含まない" "0" "$ENDS_WITH_FILE"

# ── 3. 真の失敗は空文字 (呼び出し側が非 0 で落とす) ─────────────
assert_eq "CLAUDE.md を生成しない出力では空を返す" "" \
  "$(extract_dispatch_dir 'ERROR: task not found in tickets.json')"

assert_eq "dir だけ現れて CLAUDE.md が無い出力でも空を返す" "" \
  "$(extract_dispatch_dir 'workdir=/tmp/atelier-dispatch-T-X-01-ab12Cd (generation aborted)')"

assert_eq "空の出力では空を返す" "" "$(extract_dispatch_dir '')"

# ── 4. 呼び出し側が真の失敗で非 0 終了すること (end-to-end) ──────
# 実 dispatch を差し替えるのは重いので、抽出が空 → exit 4 という
# begin-task.sh の分岐条件そのものを再現して確認する。
CASES=$((CASES + 1))
if (
  set -e
  TMP_DIR="$(extract_dispatch_dir 'ERROR: nothing generated')"
  if [ -z "$TMP_DIR" ] || [ ! -f "$TMP_DIR/CLAUDE.md" ]; then
    exit 4
  fi
  exit 0
); then
  echo "  ✗ 真の dispatch 失敗が非 0 にならない (偽の成功)" >&2
  FAILURES=$((FAILURES + 1))
else
  [ "$?" -eq 4 ] && echo "  ✓ 真の dispatch 失敗は exit 4 のまま" || {
    echo "  ✗ 想定外の終了コード" >&2
    FAILURES=$((FAILURES + 1))
  }
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "✅ PASS: $CASES cases"
  exit 0
fi
echo "❌ FAIL: $FAILURES / $CASES cases" >&2
exit 1
