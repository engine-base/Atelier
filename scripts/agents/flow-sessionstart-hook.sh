#!/usr/bin/env bash
# SessionStart hook: CC_ROLE=pm|dev|qa のセッション起動/再開時に、役割 boot
# プロンプトと現在のバトン状態を自動でコンテキスト注入する。
# tmux の文字打ち込み (タイミング依存) に頼らず役割を確実に読み込ませるための
# 決定論的な注入経路。CC_ROLE 無しの通常セッションでは何も出力しない。
# docs/agents/README.md 参照。
set -uo pipefail

ROLE="${CC_ROLE:-}"
[ -z "$ROLE" ] && exit 0

REPO="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
BOOT="$REPO/docs/agents/boot/$ROLE.txt"
[ -f "$BOOT" ] || exit 0

echo "[flow-kit 役割自動注入 / CC_ROLE=$ROLE]"
cat "$BOOT"
echo ""
echo "この指示は SessionStart hook により自動投入された。セッションが再開・要約された後もこの役割 ($ROLE) を維持すること。"

STATE="$REPO/.flow/state.json"
if [ -f "$STATE" ]; then
  echo ""
  echo "現在のバトン状態 (.flow/state.json — 再開時はここから現在地を復元する):"
  "$REPO/scripts/agents/flow.sh" status 2> /dev/null | head -14 || true
fi
exit 0
