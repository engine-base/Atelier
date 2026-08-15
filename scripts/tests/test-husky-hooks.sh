#!/usr/bin/env bash
# T-F-50: husky hook が v10 互換であり、**かつ強制が弱まっていない**ことの検証 (GAP-119)。
#
# 移行のついでにゲートを緩めないことが本タスクの肝なので、
# 「shim 行が無い」という静的確認だけでなく、**hook を実際に実行**して
#   - feat/t-x-y-* で CLAUDE.md.task が無い commit が拒否される (CLAUDE.md ルール 8)
#   - CLAUDE.md.task があれば通る
#   - commit-msg が conventional commits 形式を従来どおり弾く
# を確認する。
#
# usage: ./scripts/tests/test-husky-hooks.sh   (pnpm run test:hooks)
# exit:  0 = 全 PASS / 1 = 1 件でも FAIL

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILURES=0
CASES=0

pass() {
  CASES=$((CASES + 1))
  echo "  ✓ $1"
}

fail() {
  CASES=$((CASES + 1))
  FAILURES=$((FAILURES + 1))
  echo "  ✗ $1" >&2
  [ $# -ge 2 ] && echo "      $2" >&2
}

echo "T-F-50: husky hooks"

# ─────────────────────────────────────────────────────────────
# 1. v10 互換 — 旧形式の shim 行と shebang を持たない
# ─────────────────────────────────────────────────────────────
for hook in pre-commit commit-msg; do
  file="$REPO_ROOT/.husky/$hook"
  if [ ! -f "$file" ]; then
    fail "$hook が存在する"
    continue
  fi
  # 実際の source 行だけを見る (説明コメント中の語には反応させない)
  if grep -qE '^[[:space:]]*(\.|source)[[:space:]]+.*husky\.sh' "$file"; then
    fail "$hook に shim 行 (_/husky.sh) が無い"
  else
    pass "$hook に shim 行 (_/husky.sh) が無い"
  fi
  if head -1 "$file" | grep -q '^#!'; then
    fail "$hook に shebang が無い" "$(head -1 "$file")"
  else
    pass "$hook に shebang が無い"
  fi
  # shebang を外すと shellcheck が対象シェルを判定できず SC2148 (error) になる。
  # husky v10 互換を保ったまま静的検査も通すため、directive で shell を宣言する。
  if grep -q '^# shellcheck shell=' "$file"; then
    pass "$hook に shellcheck shell directive がある"
  else
    fail "$hook に shellcheck shell directive がある"
  fi
done

# ─────────────────────────────────────────────────────────────
# 2. pre-commit の強制 — 実際に走らせる
#    lint-staged は本題ではないので、PATH 先頭に no-op の pnpm を置いて隔離する。
# ─────────────────────────────────────────────────────────────
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/pnpm" <<'STUB'
#!/bin/sh
exit 0
STUB
chmod +x "$WORK/bin/pnpm"

run_pre_commit() {
  # $1 = branch 名 / $2 = "with-task" なら CLAUDE.md.task を置く
  local sandbox="$WORK/repo"
  rm -rf "$sandbox"
  mkdir -p "$sandbox"
  (
    cd "$sandbox" || exit 99
    git init -q .
    git checkout -q -b "$1"
    [ "${2:-}" = "with-task" ] && echo "spec" > CLAUDE.md.task
    PATH="$WORK/bin:$PATH" sh "$REPO_ROOT/.husky/pre-commit" >/dev/null 2>&1
  )
}

if run_pre_commit "feat/t-f-99-example"; then
  fail "CLAUDE.md.task 無しの feat/t-x-y-* は拒否される" "hook が 0 で通ってしまった"
else
  pass "CLAUDE.md.task 無しの feat/t-x-y-* は拒否される"
fi

if run_pre_commit "feat/t-f-99-example" with-task; then
  pass "CLAUDE.md.task があれば通る"
else
  fail "CLAUDE.md.task があれば通る" "hook が非 0 を返した"
fi

if run_pre_commit "chore/not-a-task"; then
  pass "task ID を含まないブランチは対象外 (従来どおり)"
else
  fail "task ID を含まないブランチは対象外 (従来どおり)"
fi

# ─────────────────────────────────────────────────────────────
# 3. commit-msg の検査 — 実際に走らせる
# ─────────────────────────────────────────────────────────────
run_commit_msg() {
  local msg_file="$WORK/msg"
  printf '%s\n' "$1" > "$msg_file"
  sh "$REPO_ROOT/.husky/commit-msg" "$msg_file" >/dev/null 2>&1
}

for good in "feat(T-F-50): ok" "fix: ok" "docs(scope): ok"; do
  if run_commit_msg "$good"; then
    pass "conventional 形式は通る: $good"
  else
    fail "conventional 形式は通る: $good"
  fi
done

for bad in "updated stuff" "FEAT: shouting" "feat missing colon"; do
  if run_commit_msg "$bad"; then
    fail "非 conventional 形式は拒否される: $bad" "通ってしまった"
  else
    pass "非 conventional 形式は拒否される: $bad"
  fi
done

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "✅ PASS: $CASES cases"
  exit 0
fi
echo "❌ FAIL: $FAILURES / $CASES cases" >&2
exit 1
