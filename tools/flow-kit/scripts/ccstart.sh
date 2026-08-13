#!/usr/bin/env bash
# ccstart — 3 役自走セッション (pm / dev / qa) をワンコマンドで起動する。
#
#   ./scripts/ccstart.sh          # macOS Terminal では 3 ウィンドウ、無ければ 1 画面 3 ペイン
#   CC_PANES=1 ./scripts/ccstart.sh  # 常に 1 画面 3 ペイン (tmux split) で開く
#   NO_RC=1 ./scripts/ccstart.sh     # /rc (スマホ Remote Control) の自動有効化を省略
#   NO_AUTO=1 ./scripts/ccstart.sh   # 許可リストを書かない (通常のプロンプトあり)
#
# 対応 OS: macOS (3 ウィンドウ) / Linux (3 ペイン) / Windows は WSL2 内で Linux 同様。
#   ネイティブ Windows は Claude Code のセッション間メッセージ未提供のため対象外。
# 前提: tmux + Claude Code CLI v2.1.224 以上 (/login 済み)。
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

# 権限モード:
#  既定 (Mac 推奨) = プロジェクトの .claude/settings.local.json に許可リストを書き、
#    ツール実行時のプロンプトを出さない (bypassPermissions の警告ダイアログも出ない)。
#  CC_BYPASS=1     = --permission-mode bypassPermissions (隔離コンテナ用。Mac では毎回
#    警告が出るため非推奨)。
#  NO_AUTO=1       = 何もしない (通常のプロンプトあり)。
CLAUDE_ARGS=""
if [ -n "${CC_BYPASS:-}" ] && [ -z "${NO_AUTO:-}" ]; then
  CLAUDE_ARGS="--permission-mode bypassPermissions"
fi

# フォルダ信頼ダイアログを事前承認 (これは設定で確実に抑止できる)。
python3 - "$REPO" << 'PYEOF'
import json
import os
import sys

repo = sys.argv[1]
path = os.path.expanduser("~/.claude.json")
try:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    cfg = {}
proj = cfg.setdefault("projects", {}).setdefault(repo, {})
proj["hasTrustDialogAccepted"] = True
proj.setdefault("hasCompletedProjectOnboarding", True)
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
print("  ✓ フォルダ信頼を事前承認")
if cfg.get("oauthAccount"):
    print("  ✓ Claude アカウントにログイン済み (プランで動作)")
else:
    print("  ⚠ Claude アカウント未ログイン — 画面にログイン選択が出たら 1 ウィンドウで")
    print("    一度だけ完了してください (全セッション共通。以後は自動)")
PYEOF

# 許可リスト方式 (既定): ツール実行をプロンプトなしで通す。bypass の警告も出ない。
if [ -z "${NO_AUTO:-}" ] && [ -z "${CC_BYPASS:-}" ]; then
  python3 - "$REPO" << 'PYEOF'
import json
import os
import sys

repo = sys.argv[1]
path = os.path.join(repo, ".claude", "settings.local.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
try:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
except Exception:
    cfg = {}
allow = [
    "Bash", "Edit", "Write", "Read", "Glob", "Grep", "LS",
    "WebFetch", "WebSearch", "TodoWrite", "Task", "NotebookEdit",
    "BashOutput", "KillShell", "Skill", "SendMessage", "ListAgents",
]
perms = cfg.setdefault("permissions", {})
cur = perms.setdefault("allow", [])
for a in allow:
    if a not in cur:
        cur.append(a)
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
print(f"  ✓ 許可リストを設定 (.claude/settings.local.json — プロンプトなしで自走)")
PYEOF
fi

# バトン状態を初期化 (前回のランタイム状態を引き継がない)
rm -f "$REPO/.flow/state.json"
mkdir -p "$REPO/.flow/reports"

# --------------------------------------------------------------------------- #
# 共通ヘルパ (tmux target = "session" または "session:pane")
# --------------------------------------------------------------------------- #
start_target() {  # target role
  # 課金は Claude アカウントのプラン (subscription ログイン) を必ず使う。
  # シェル設定 (.zshrc 等) に ANTHROPIC_API_KEY などが残っていると claude が
  # API 従量課金 (API Usage Billing) に切り替わってしまうため、既定でキー系の
  # 環境変数をすべて外して起動する。キー認証で動かしたい特殊環境 (コンテナ/CI)
  # のみ CC_USE_API_KEY=1 で従来どおり。
  local envprefix="env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_API_KEY "
  [ -n "${CC_USE_API_KEY:-}" ] && envprefix=""
  tmux send-keys -t "$1" "${envprefix}CC_ROLE=$2 $CLAUDE_BIN $CLAUDE_ARGS" C-m
}

drive_onboarding() {  # target — 画面を監視して案内を閉じ、入力欄到達で 0 を返す
  # 固定タイミング送信は不可 (案内は claude 起動から数秒遅れて描画されるため
  # 空振りする)。人間と同じく「画面を見て、案内が出たら閉じ、入力欄が出るまで
  # 待つ」を 1 秒ごとに繰り返す。判定は Mac 実画面テキストで検証済み:
  #   ・"Esc to cancel" を含む選択案内 (fullscreen renderer 等) → Esc で既定維持
  #   ・"Enter to confirm" だけの案内 → Enter で既定選択
  #   ・"for short"(? for shortcuts) → 入力欄に到達 (案内なし)
  local tries="${CC_BOOT_TRIES:-180}" boot_tries screen ready_seen=0
  # まず claude プロセス起動を待つ。プロセス名は環境で異なる:
  #   Mac 実機 = claude.exe (実測・tmux ステータスバーで確認) / Linux = claude / 旧 = node
  # 名前を固定列挙すると新環境で外れるため *claude* を部分一致で拾う。
  # 検出できなくても致命ではない (画面監視が本体) ので待ちは最大 30 秒に留め、
  # タイムアウト時もそのまま画面監視へ進む。
  boot_tries="$tries"
  [ "$boot_tries" -gt 30 ] && boot_tries=30
  while [ "$boot_tries" -gt 0 ]; do
    case "$(tmux display-message -p -t "$1" '#{pane_current_command}' 2> /dev/null)" in
      node | bun | *[Cc]laude*) break ;;
    esac
    sleep 1
    boot_tries=$((boot_tries - 1))
  done
  # 画面遷移を監視
  while [ "$tries" -gt 0 ]; do
    screen="$(tmux capture-pane -t "$1" -p 2> /dev/null || true)"
    if printf '%s' "$screen" | grep -q "Esc to cancel"; then
      tmux send-keys -t "$1" Escape
      ready_seen=0
      sleep 1
    elif printf '%s' "$screen" | grep -q "Enter to confirm"; then
      tmux send-keys -t "$1" Enter
      ready_seen=0
      sleep 1
    elif printf '%s' "$screen" | grep -q "for short"; then
      # 案内が無く入力欄が出ている状態が 2 連続で続けば確定 (描画途中の誤検出防止)
      ready_seen=$((ready_seen + 1))
      [ "$ready_seen" -ge 2 ] && return 0
      sleep 1
    else
      ready_seen=0
      sleep 1
    fi
    tries=$((tries - 1))
  done
  echo "  ⚠ $1 が入力欄に到達しませんでした (そのウィンドウで Esc → /rename <役割> を手動入力)"
  return 1
}

setup_target() {  # target role
  drive_onboarding "$1" || return 0
  tmux send-keys -t "$1" -l "/rename $2"
  tmux send-keys -t "$1" C-m
  sleep 3
  # 注意: /goal はここで自動設定しない。/goal はゴール未達の間セッションを
  # 自動継続し続けるため、バトン待ちの役に付けると待機中もモデルが回り続け
  # プラン枠を空費する (コンテナ実測: 待機のみで 2.5 分 8.7k トークン)。
  # 継続性は Stop hook (flow-stop-hook.sh) が担う。
  if [ -z "${NO_RC:-}" ]; then
    tmux send-keys -t "$1" -l "/rc"
    tmux send-keys -t "$1" C-m
    sleep 3
  fi
}

keepawake() {  # session-name — スリープ防止 (OS にあるものを使う。無ければ何もしない)
  if command -v caffeinate > /dev/null; then  # macOS
    tmux new-session -d -s "$1" -c "$REPO" "caffeinate -dis" 2> /dev/null || true
  elif command -v systemd-inhibit > /dev/null; then  # Linux
    tmux new-session -d -s "$1" -c "$REPO" \
      "systemd-inhibit --what=idle:sleep --why=flow-kit sleep infinity" 2> /dev/null || true
  fi
  # WSL はホスト (Windows) 側の電源設定でスリープを止める (README 参照)
}

kickoff() {  # pm-target — 開始文の案内、CC_AUTO_START=1 なら pm へ自動送信
  local file="$REPO/docs/agents/kickoff.txt"
  [ -f "$file" ] || { echo "  pm ウィンドウに開始の一言を入力してください"; return 0; }
  if [ -n "${CC_AUTO_START:-}" ]; then
    tmux send-keys -t "$1" -l "$(tr -d '\n' < "$file")"
    tmux send-keys -t "$1" C-m
    echo "  ✓ pm に開始文を自動送信しました — 以後は放置で回ります"
  else
    echo "  『◯◯ 準備完了』を確認したら、pm ウィンドウに次をコピペ (開始文):"
    echo "  ----------------------------------------------------------------"
    sed 's/^/  /' "$file"
    echo "  ----------------------------------------------------------------"
    echo "  (次回から CC_AUTO_START=1 ./scripts/ccstart.sh で送信まで全自動にできます)"
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
  # 先にウィンドウを開く (claude 起動が各ウィンドウ内で見える) — dev/qa/pm 順で pm 最前面
  echo "  3 ウィンドウを起動中..."
  for role in dev qa pm; do
    osascript > /dev/null 2>&1 <<OSA || echo "  ⚠ $role のウィンドウを開けませんでした → 手動で新規ターミナルに: tmux attach -t flow-$role"
tell application "Terminal"
  activate
  do script "tmux attach -t flow-$role"
  set custom title of front window to "$role"
end tell
OSA
  done
  # 各ウィンドウで claude が起動しきったら /rename・/rc を送る (ユーザーには live で見える)
  setup_target flow-dev dev
  setup_target flow-qa qa
  setup_target flow-pm pm
  echo ""
  echo "起動しました (3 ウィンドウ: pm / dev / qa)"
  kickoff flow-pm
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
kickoff "$SESSION:flow.0"
echo "  スマホ: 各ペインの /rc 出力の案内どおり Claude アプリの Code タブから接続"
echo "  停止: tmux kill-session -t $SESSION"
if [ -t 0 ]; then
  tmux attach -t "$SESSION"
else
  echo "  (非対話環境のため attach 省略 — 画面を見るには: tmux attach -t $SESSION)"
fi
