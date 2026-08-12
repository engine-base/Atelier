#!/usr/bin/env bash
# ccstart — 3 役自走セッション (pm / dev / qa) をワンコマンドで起動する。
#
#   ./scripts/ccstart.sh          # macOS Terminal では 3 ウィンドウ、無ければ 1 画面 3 ペイン
#   CC_PANES=1 ./scripts/ccstart.sh  # 常に 1 画面 3 ペイン (tmux split) で開く
#   NO_RC=1 ./scripts/ccstart.sh     # /rc (スマホ Remote Control) の自動有効化を省略
#   NO_AUTO=1 ./scripts/ccstart.sh   # 権限自動承認 (--permission-mode bypassPermissions) を省略
#
# 前提: macOS + tmux + Claude Code CLI v2.1.224 以上 (/login 済み)。
# 各セッションの流れ: claude 起動 → (役割は SessionStart hook が自動注入) → /rename → /rc。
# 停止コマンドは起動完了時に表示する。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

command -v tmux > /dev/null || { echo "tmux が必要です (brew install tmux)"; exit 1; }
command -v "$CLAUDE_BIN" > /dev/null || { echo "claude CLI が見つかりません"; exit 1; }

# 表示モード: macOS Terminal が使えれば 3 ウィンドウ、そうでなければ 3 ペイン。
# CC_PANES=1 で常にペイン、CC_WINDOWS=1 で常にウィンドウを強制。
if [ -n "${CC_PANES:-}" ]; then
  MODE="panes"
elif [ -n "${CC_WINDOWS:-}" ]; then
  MODE="windows"
elif command -v osascript > /dev/null && osascript -e 'id of app "Terminal"' > /dev/null 2>&1; then
  MODE="windows"
else
  MODE="panes"
fi

CLAUDE_ARGS=""
if [ -z "${NO_AUTO:-}" ]; then
  CLAUDE_ARGS="--permission-mode bypassPermissions"
fi

# 初回起動時の確認ダイアログ (フォルダ信頼 / 自動承認モード同意) を事前承認して
# そもそも表示させない — ダイアログ表示中に自動キー入力が届くと Enter が
# 「No, exit」を選んで claude が終了する事故 (Mac 初回実走で検出) の恒久対策。
python3 - "$REPO" "${NO_AUTO:-}" << 'PYEOF'
import json
import os
import sys

repo, no_auto = sys.argv[1], sys.argv[2]
path = os.path.expanduser("~/.claude.json")
try:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    cfg = {}
if not no_auto:
    cfg["bypassPermissionsModeAccepted"] = True
proj = cfg.setdefault("projects", {}).setdefault(repo, {})
proj["hasTrustDialogAccepted"] = True
proj.setdefault("hasCompletedProjectOnboarding", True)
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
label = "フォルダ信頼" + ("" if no_auto else " + 自動承認モード同意")
print(f"  ✓ 初回確認ダイアログを事前承認 ({label})")
PYEOF

# バトン状態を初期化 (前回のランタイム状態を引き継がない)
rm -f "$REPO/.flow/state.json"
mkdir -p "$REPO/.flow/reports"

# --------------------------------------------------------------------------- #
# 共通ヘルパ (tmux target = "session" または "session:pane")
# --------------------------------------------------------------------------- #
start_target() {  # target role
  tmux send-keys -t "$1" "CC_ROLE=$2 $CLAUDE_BIN $CLAUDE_ARGS" C-m
}

wait_ready() {  # target
  local tries="${CC_BOOT_TRIES:-60}"
  while [ "$tries" -gt 0 ]; do
    if tmux capture-pane -t "$1" -p 2> /dev/null | grep -q "? for shortcuts"; then
      return 0
    fi
    sleep 2
    tries=$((tries - 1))
  done
  echo "  ⚠ $1 が起動待ちタイムアウト (手動で /rename を打ってください)"
  return 1
}

setup_target() {  # target role
  wait_ready "$1" || return 0
  tmux send-keys -t "$1" -l "/rename $2"
  tmux send-keys -t "$1" C-m
  sleep 3
  if [ -z "${NO_RC:-}" ]; then
    tmux send-keys -t "$1" -l "/rc"
    tmux send-keys -t "$1" C-m
    sleep 3
  fi
}

keepawake() {  # session-name
  if command -v caffeinate > /dev/null; then
    tmux new-session -d -s "$1" -c "$REPO" "caffeinate -dis" 2> /dev/null || true
  fi
}

if [ "$MODE" = "windows" ]; then
  # ===== 3 ウィンドウモード (macOS Terminal) =====
  # 役割ごとに独立した tmux セッションを作り、各 Terminal ウィンドウで attach する。
  # ウィンドウを閉じてもセッションは生存 (tmux attach -t flow-<役割> で再表示)。
  for role in pm dev qa; do
    if tmux has-session -t "flow-$role" 2> /dev/null; then
      echo "セッション flow-$role は起動済みです。tmux attach -t flow-$role で開いてください。"
      exit 0
    fi
  done
  keepawake flow-keepawake
  for role in pm dev qa; do
    tmux new-session -d -s "flow-$role" -c "$REPO"
    start_target "flow-$role" "$role"
  done
  # dev / qa を先に整え、pm を最後に
  setup_target flow-dev dev
  setup_target flow-qa qa
  setup_target flow-pm pm
  # 各役割を独立した Terminal ウィンドウで開く (pm を最後 = 最前面に)
  for role in dev qa pm; do
    osascript > /dev/null 2>&1 <<OSA || echo "  ⚠ $role のウィンドウを開けませんでした → 手動: tmux attach -t flow-$role"
tell application "Terminal"
  activate
  do script "tmux attach -t flow-$role"
  set custom title of front window to "$role"
end tell
OSA
  done
  echo ""
  echo "起動しました (3 ウィンドウ: pm / dev / qa)"
  echo "  各ウィンドウで『◯◯ 準備完了』を確認 → pm ウィンドウに開始の一言を入力"
  echo "  例:『開始。docs/gap-tracker.md の未解消 gap を優先度順に進めて』"
  echo "  スマホ: 各ウィンドウの /rc 出力の案内どおり Claude アプリ Code タブから接続"
  echo "  ウィンドウを閉じても裏で生存 — 開き直し: tmux attach -t flow-pm (dev/qa も同様)"
  echo "  全停止: tmux kill-session -t flow-pm \\; kill-session -t flow-dev \\; kill-session -t flow-qa \\; kill-session -t flow-keepawake"
  exit 0
fi

# ===== 3 ペインモード (1 画面 tmux split) =====
SESSION="${CC_SESSION:-flow-$(basename "$REPO" | tr -c 'a-zA-Z0-9_\n-' '-' | tr -d '\n')}"
if tmux has-session -t "$SESSION" 2> /dev/null; then
  echo "セッション $SESSION は起動済みです。tmux attach -t $SESSION で開いてください。"
  exit 0
fi

tmux new-session -d -s "$SESSION" -c "$REPO" -n flow
tmux split-window -h -t "$SESSION:flow" -c "$REPO"
tmux split-window -v -t "$SESSION:flow.1" -c "$REPO"
# ペイン 0 = pm (左) / 1 = dev (右上) / 2 = qa (右下)
if command -v caffeinate > /dev/null; then
  tmux new-window -d -t "$SESSION" -n keepawake "caffeinate -dis"
fi

start_target "$SESSION:flow.0" pm
start_target "$SESSION:flow.1" dev
start_target "$SESSION:flow.2" qa

setup_target "$SESSION:flow.1" dev
setup_target "$SESSION:flow.2" qa
setup_target "$SESSION:flow.0" pm

echo ""
echo "起動しました: tmux attach -t $SESSION"
echo "  左=pm / 右上=dev / 右下=qa (各ペインで『◯◯ 準備完了』を確認)"
echo "  開始するには pm ペインに例:『開始。docs/gap-tracker.md の未解消 gap を優先度順に進めて』"
echo "  スマホ: 各ペインの /rc 出力の案内どおり Claude アプリの Code タブから接続"
echo "  停止: tmux kill-session -t $SESSION"
tmux attach -t "$SESSION"
