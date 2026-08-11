#!/usr/bin/env bash
# ccstart — 3 役自走セッション (pm / dev / qa) をワンコマンドで起動する。
#
#   ./scripts/ccstart.sh          # tmux 1 画面 (左: pm / 右上: dev / 右下: qa)
#   NO_RC=1 ./scripts/ccstart.sh  # /rc (スマホ Remote Control) の自動有効化を省略
#   NO_AUTO=1 ./scripts/ccstart.sh# 権限自動承認 (--permission-mode bypassPermissions) を省略
#
# 前提: macOS + tmux + Claude Code CLI v2.1.224 以上 (/login 済み)。
# 各ペインの流れ: caffeinate 常駐 → claude 起動 → /rename → /rc → boot プロンプト投入。
# 起動タイミングのズレで /rename 等が入らなかったペインは、手でそのまま打てば同じ
# (README.md の手動手順を参照)。停止は: tmux kill-session -t atelier-flow
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SESSION="${CC_SESSION:-flow-$(basename "$REPO" | tr -c 'a-zA-Z0-9_\n-' '-' | tr -d '\n')}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

command -v tmux > /dev/null || { echo "tmux が必要です (brew install tmux)"; exit 1; }
command -v "$CLAUDE_BIN" > /dev/null || { echo "claude CLI が見つかりません"; exit 1; }

if tmux has-session -t "$SESSION" 2> /dev/null; then
  echo "セッション $SESSION は起動済みです。tmux attach -t $SESSION で開いてください。"
  exit 0
fi

CLAUDE_ARGS=""
if [ -z "${NO_AUTO:-}" ]; then
  CLAUDE_ARGS="--permission-mode bypassPermissions"
fi

# バトン状態を初期化 (前回のランタイム状態を引き継がない)
rm -f "$REPO/.flow/state.json"
mkdir -p "$REPO/.flow/reports"

tmux new-session -d -s "$SESSION" -c "$REPO" -n flow
tmux split-window -h -t "$SESSION:flow" -c "$REPO"
tmux split-window -v -t "$SESSION:flow.1" -c "$REPO"
# ペイン 0 = pm (左) / 1 = dev (右上) / 2 = qa (右下)

# スリープ防止: tmux サーバーが生きている間 caffeinate を常駐 (macOS のみ)
if command -v caffeinate > /dev/null; then
  tmux new-window -d -t "$SESSION" -n keepawake "caffeinate -dis"
fi

start_role() {
  local pane="$1" role="$2"
  tmux send-keys -t "$SESSION:flow.$pane" "CC_ROLE=$role $CLAUDE_BIN $CLAUDE_ARGS" C-m
}

start_role 0 pm
start_role 1 dev
start_role 2 qa

# 役割プロンプトは SessionStart hook (flow-sessionstart-hook.sh) が CC_ROLE を見て
# 自動注入するため、ここで打ち込むのは /rename と /rc のみ (どちらも失敗しても
# 手で打てば同じ — README.md の手動手順)。
BOOT_WAIT="${CC_BOOT_WAIT:-15}"
echo "claude 起動待ち (${BOOT_WAIT} 秒 — 遅い環境は CC_BOOT_WAIT=30 等で調整)..."
sleep "$BOOT_WAIT"

setup_role() {
  local pane="$1" role="$2"
  tmux send-keys -t "$SESSION:flow.$pane" -l "/rename $role"
  tmux send-keys -t "$SESSION:flow.$pane" C-m
  sleep 3
  if [ -z "${NO_RC:-}" ]; then
    tmux send-keys -t "$SESSION:flow.$pane" -l "/rc"
    tmux send-keys -t "$SESSION:flow.$pane" C-m
    sleep 3
  fi
}

# dev / qa を先に整え、pm を最後に
setup_role 1 dev
setup_role 2 qa
setup_role 0 pm

echo ""
echo "起動しました: tmux attach -t $SESSION"
echo "  左=pm / 右上=dev / 右下=qa (役割は SessionStart hook が自動注入 — 各ペインで『◯◯ 準備完了』を確認)"
echo "  開始するには pm ペインに例:『開始。docs/gap-tracker.md の未解消 gap を優先度順に進めて』"
echo "  スマホ: 各ペインの /rc 出力の案内どおり Claude アプリの Code タブから接続"
echo "  停止: tmux kill-session -t $SESSION"
tmux attach -t "$SESSION"
