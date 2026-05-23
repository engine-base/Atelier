#!/usr/bin/env bash
# JIT Task atomic STEP 0-3 executor.
#
# 目的: AI / 人間が JIT skill の STEP を 1 つでもサボれないように、
#       全ステップを 1 つの bash で atomic に実行する。
#       1 つでも fail したら set -e で abort。
#
# 使い方:
#   ./scripts/begin-task.sh T-D-22
#
# 実行内容:
#   STEP 0: validate.sh
#   STEP 2: dispatch.sh --preview (.jit/preview-T-X-Y.log に記録)
#   STEP 3: dispatch.sh + branch 作成 + CLAUDE.md.task 配置 + /goal 生成
#
# 結果:
#   - ./CLAUDE.md.task               (タスク仕様、git 対象外)
#   - .jit/preview-T-X-Y.log         (preview 全文)
#   - .jit/goal-T-X-Y.txt            (/goal 用テキスト)
#   - .jit/dispatch-T-X-Y.path       (dispatch tmp dir のパス)
#   - 新ブランチに switch 済
#
# 失敗時:
#   - validate.sh fail → abort、tickets.json 修正 PR を先行せよ
#   - dispatch.sh fail → tickets.json に該当 task が存在するか確認
#   - branch すでに存在 → 既存ブランチを再利用するか手動 cleanup

set -euo pipefail

TASK_ID="${1:-}"
if [ -z "$TASK_ID" ]; then
  echo "❌ usage: $0 T-X-Y (例: T-D-22)" >&2
  exit 1
fi

# 大文字化
TASK_ID="$(echo "$TASK_ID" | tr '[:lower:]' '[:upper:]')"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

mkdir -p .jit

# ─────────────────────────────────────────
# STEP 0: validate.sh が PASS していなければ実装着手不可
# ─────────────────────────────────────────
echo "🔍 STEP 0: validate.sh ..."
if ! ./09_dispatch/scripts/validate.sh 2>&1 | tee .jit/validate.log | tail -3 | grep -q "PASS"; then
  echo "❌ validate.sh did not PASS. Fix tickets.json first." >&2
  exit 2
fi
echo "✅ STEP 0 PASS"

# ─────────────────────────────────────────
# STEP 2: preview を必ず保存
# ─────────────────────────────────────────
echo "🔍 STEP 2: preview $TASK_ID ..."
PREVIEW_LOG=".jit/preview-${TASK_ID}.log"
./09_dispatch/scripts/dispatch.sh --preview "$TASK_ID" > "$PREVIEW_LOG" 2>&1
if ! grep -q "実装ブランチ" "$PREVIEW_LOG"; then
  echo "❌ preview did not produce branch name. Check $PREVIEW_LOG" >&2
  exit 3
fi
echo "✅ STEP 2 PASS (preview saved to $PREVIEW_LOG)"

# ─────────────────────────────────────────
# STEP 3: dispatch (実 generate) + branch + CLAUDE.md.task 配置
# ─────────────────────────────────────────
echo "🔍 STEP 3: dispatch + branch + CLAUDE.md.task ..."
DISPATCH_OUT="$(./09_dispatch/scripts/dispatch.sh "$TASK_ID" 2>&1)"
echo "$DISPATCH_OUT" > ".jit/dispatch-${TASK_ID}.log"

TMP_DIR="$(echo "$DISPATCH_OUT" | grep -oE '/tmp/atelier-dispatch-[^ ]+' | head -1)"
if [ -z "$TMP_DIR" ] || [ ! -f "$TMP_DIR/CLAUDE.md" ]; then
  echo "❌ dispatch did not produce CLAUDE.md. Output: $DISPATCH_OUT" >&2
  exit 4
fi
echo "$TMP_DIR" > ".jit/dispatch-${TASK_ID}.path"

BRANCH_NAME="$(grep '実装ブランチ' "$TMP_DIR/CLAUDE.md" | sed 's/.*: //' | head -1)"
if [ -z "$BRANCH_NAME" ]; then
  echo "❌ could not extract branch name from $TMP_DIR/CLAUDE.md" >&2
  exit 5
fi

# 既存ブランチ check
if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "⚠ branch $BRANCH_NAME already exists. Switching to it."
  git checkout "$BRANCH_NAME"
else
  git checkout -b "$BRANCH_NAME"
fi

# CLAUDE.md.bak 退避 + CLAUDE.md.task 配置
if [ -f CLAUDE.md ] && [ ! -L CLAUDE.md ]; then
  cp CLAUDE.md CLAUDE.md.bak 2>/dev/null || true
fi
cp "$TMP_DIR/CLAUDE.md" "./CLAUDE.md.task"

echo "✅ STEP 3 PASS (branch=$BRANCH_NAME, CLAUDE.md.task placed)"

# ─────────────────────────────────────────
# STEP 3 extra: /goal テキストを生成
# ─────────────────────────────────────────
GOAL_SCRIPT="$HOME/.claude/skills/jit-task-execution/scripts/generate_goal.py"
GOAL_FILE=".jit/goal-${TASK_ID}.txt"
if [ -f "$GOAL_SCRIPT" ]; then
  if python3 "$GOAL_SCRIPT" "$TASK_ID" > "$GOAL_FILE" 2>&1; then
    echo "✅ /goal text generated: $GOAL_FILE"
  else
    echo "⚠ generate_goal.py failed (non-fatal). See $GOAL_FILE for details."
  fi
else
  echo "⚠ generate_goal.py not found at $GOAL_SCRIPT (non-fatal)"
fi

# ─────────────────────────────────────────
# 完了
# ─────────────────────────────────────────
echo ""
echo "🎉 JIT task $TASK_ID READY"
echo "   branch: $BRANCH_NAME"
echo "   spec:   ./CLAUDE.md.task  (READ THIS BEFORE CODING)"
echo "   goal:   $GOAL_FILE"
echo "   preview log: $PREVIEW_LOG"
echo ""
echo "次の手順:"
echo "  1. cat ./CLAUDE.md.task  ← ファイル境界 / 3-tier AC を頭に入れる"
echo "  2. files_changed_predicted.new / modify のみ touch"
echo "  3. 完了後: git push (CLAUDE.md.task は .gitignore 対象、commit されない)"
