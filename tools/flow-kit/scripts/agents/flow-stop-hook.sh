#!/usr/bin/env bash
# Stop hook: 3 役セッション (CC_ROLE=pm|dev|qa) がバトン未送信のままターンを
# 終えようとしたら差し戻す (exit 2 の stderr がセッションへの指示になる)。
# ccstart.sh 経由で CC_ROLE が設定されたセッションにのみ作用し、
# 通常セッションでは何もしない。docs/agents/protocol.md 参照。
set -uo pipefail

ROLE="${CC_ROLE:-}"
[ -z "$ROLE" ] && exit 0

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
STATE="$REPO/.flow/state.json"
[ -f "$STATE" ] || exit 0

FLOW_HOOK_INPUT="$(cat 2>/dev/null || true)"
export FLOW_HOOK_INPUT

python3 - "$STATE" "$ROLE" << 'PYEOF'
import json
import os
import sys

state_path, role = sys.argv[1], sys.argv[2]
raw = os.environ.get("FLOW_HOOK_INPUT", "")
try:
    hook_input = json.loads(raw) if raw.strip() else {}
except json.JSONDecodeError:
    hook_input = {}

# 直前の Stop hook 差し戻しから継続中なら再ブロックしない (無限ループ防止)
if hook_input.get("stop_hook_active"):
    sys.exit(0)

try:
    with open(state_path, encoding="utf-8") as f:
        st = json.load(f)
except (OSError, json.JSONDecodeError):
    sys.exit(0)

if st.get("holder") == role and not st.get("handoff_sent", True):
    task = st.get("task") or "(task 未設定)"
    sys.stderr.write(
        f"[flow-stop-hook] あなた ({role}) は {task} のバトン保持者のまま終了しようとしています。"
        "docs/agents/protocol.md に従い、終了前に必ず次を完了してください: "
        "(1) 成果・結果をファイルに記録 "
        "(2) 次の役割へ種別プレフィックス付きメッセージを送信 "
        "(3) ./scripts/agents/flow.sh handoff <自分> <相手> \"<種別: 要約>\" を実行。"
        "ユーザー回答待ちで止まるのが正しい場合 (PM のみ) は "
        "./scripts/agents/flow.sh wait-user \"<確認内容>\" を実行してください。"
    )
    sys.exit(2)
sys.exit(0)
PYEOF
exit $?
