#!/usr/bin/env bash
# flow-kit installer — 任意のプロジェクトに 3 役自走運用 (PM/dev/qa) を導入する。
#
#   ./install.sh /path/to/your-project
#
# やること:
#   1. scripts/ccstart.sh + scripts/agents/{flow.sh,flow-stop-hook.sh} を配置 (常に最新へ上書き)
#   2. docs/agents/ に役割定義・プロトコル・boot プロンプトを配置 (既存ファイルは上書きしない)
#   3. .claude/settings.json に Stop hook をマージ (既存設定は保持)
#   4. .gitignore に .flow/ を追記
# 導入後: docs/agents/project.md を埋めて ./scripts/ccstart.sh で起動 (docs/agents/README.md 参照)。
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:?usage: ./install.sh /path/to/project-root}"
TARGET="$(cd "$TARGET" && pwd)"

if [ ! -d "$TARGET/.git" ]; then
  echo "⚠ $TARGET は git リポジトリではありません (続行しますが、バトン保持者制の git 運用が前提です)"
fi

echo "flow-kit を導入: $TARGET"

# 1. スクリプト (常に最新へ上書き)
mkdir -p "$TARGET/scripts/agents"
cp "$KIT/scripts/ccstart.sh" "$TARGET/scripts/ccstart.sh"
cp "$KIT/scripts/agents/flow.sh" "$KIT/scripts/agents/flow-stop-hook.sh" \
  "$KIT/scripts/agents/flow-sessionstart-hook.sh" "$TARGET/scripts/agents/"
chmod +x "$TARGET/scripts/ccstart.sh" "$TARGET/scripts/agents/"*.sh
echo "  ✓ scripts/ccstart.sh, scripts/agents/{flow.sh,flow-stop-hook.sh,flow-sessionstart-hook.sh}"

# 2. 役割定義 (既存を尊重 — 無いものだけ配置)
mkdir -p "$TARGET/docs/agents/boot"
for f in README.md protocol.md project.md pm.md dev.md qa.md rehearsal.md; do
  if [ -f "$TARGET/docs/agents/$f" ]; then
    echo "  - docs/agents/$f は既存のため保持"
  else
    cp "$KIT/templates/$f" "$TARGET/docs/agents/$f"
    echo "  ✓ docs/agents/$f"
  fi
done
for f in pm.txt dev.txt qa.txt; do
  if [ -f "$TARGET/docs/agents/boot/$f" ]; then
    echo "  - docs/agents/boot/$f は既存のため保持"
  else
    cp "$KIT/templates/boot/$f" "$TARGET/docs/agents/boot/$f"
    echo "  ✓ docs/agents/boot/$f"
  fi
done

# 3. .claude/settings.json に Stop / SessionStart hook をマージ
mkdir -p "$TARGET/.claude"
python3 - "$TARGET/.claude/settings.json" << 'PYEOF'
import json
import sys

path = sys.argv[1]
try:
    with open(path, encoding="utf-8") as f:
        settings = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    settings = {}

hooks = settings.setdefault("hooks", {})
changed = False
for event, script in (
    ("Stop", "flow-stop-hook.sh"),
    ("SessionStart", "flow-sessionstart-hook.sh"),
):
    hook_cmd = f'"$CLAUDE_PROJECT_DIR"/scripts/agents/{script}'
    entries = hooks.setdefault(event, [])
    already = any(
        h.get("command") == hook_cmd
        for entry in entries
        for h in entry.get("hooks", [])
        if isinstance(h, dict)
    )
    if already:
        print(f"  - .claude/settings.json の {event} hook は設定済み")
    else:
        entries.append({"hooks": [{"type": "command", "command": hook_cmd}]})
        changed = True
        print(f"  ✓ .claude/settings.json に {event} hook を追加")
if changed:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(settings, f, ensure_ascii=False, indent=2)
        f.write("\n")
PYEOF

# 4. .gitignore に .flow/
if [ -f "$TARGET/.gitignore" ] && grep -qE '^\.flow/$' "$TARGET/.gitignore"; then
  echo "  - .gitignore の .flow/ は設定済み"
else
  {
    echo ""
    echo "# 3 役自走運用のランタイム状態 (docs/agents/README.md)"
    echo ".flow/"
  } >> "$TARGET/.gitignore"
  echo "  ✓ .gitignore に .flow/ を追記"
fi

echo ""
echo "導入完了。次の手順:"
echo "  1. $TARGET/docs/agents/project.md を埋める (仕様の正・DoD・検証手段・検収基準)"
echo "  2. cd $TARGET && ./scripts/ccstart.sh"
echo "  3. 3 ペインの「準備完了」を確認して pm に開始の一言"
