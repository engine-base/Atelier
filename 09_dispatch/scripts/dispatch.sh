#!/usr/bin/env bash
# Atelier JIT Dispatcher
# Usage:
#   ./dispatch.sh <TASK_ID>          # 生成して Claude Code を起動
#   ./dispatch.sh --preview <TASK_ID>  # 標準出力に CLAUDE.md を吐くだけ
#   ./dispatch.sh --all-preview       # 全 190 タスクの CLAUDE.md を /tmp に書き出し（人間レビュー用）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TICKETS="$ROOT/07_tasks/tickets.json"
TEMPLATE="$ROOT/09_dispatch/CLAUDE.md.template"

if [ ! -f "$TICKETS" ]; then echo "❌ tickets.json not found: $TICKETS"; exit 1; fi
if [ ! -f "$TEMPLATE" ]; then echo "❌ template not found: $TEMPLATE"; exit 1; fi

generate() {
  local TID="$1"
  TID="$TID" TICKETS="$TICKETS" TEMPLATE="$TEMPLATE" python3 - <<'PY'
import json, sys, pathlib, re, datetime, os
tid = os.environ["TID"]
tickets = json.loads(pathlib.Path(os.environ["TICKETS"]).read_text())
t = next((x for x in tickets["tasks"] if x["id"]==tid), None)
if not t:
    print(f"ERROR: task {tid} not found", file=sys.stderr); sys.exit(1)

tmpl = pathlib.Path(os.environ["TEMPLATE"]).read_text()

# Build branch name
title = t["title"]
slug = re.sub(r'[（）()【】\[\]・/、,\.：:＋+]', ' ', title)
slug = re.sub(r'\s+', '-', slug.strip().lower())
slug = re.sub(r'[^a-z0-9\-]', '', slug)[:40].strip('-') or 'task'
prefix = {"NEW":"feat","REFACTOR":"refactor","REUSE":"feat","FIX":"fix","ARCHIVE":"chore"}.get(t["label"],"feat")
if t.get("category") == "cleanup": prefix = "chore"
branch = f"{prefix}/{tid.lower()}-{slug}"

# Format file lists
def fmt_files(arr):
    return "\n".join(f"- \`{x}\`" for x in arr) if arr else "- なし"

fc = t.get("files_changed_predicted", {})
files_new      = fmt_files(fc.get("new",[]))
files_modify   = fmt_files(fc.get("modify",[]))
files_shared   = fmt_files(fc.get("shared_read",[]))
files_forbid   = fmt_files(fc.get("forbidden",[]))

# Format AC
ac = t.get("acceptance_criteria_inline", {})
tier1 = "\n".join(f"- [ ] {x}" for x in ac.get("tier_1_structural",[])) or "- [ ] （tickets.json#acceptance_criteria_inline.tier_1_structural が空。要記入）"
def fmt_ears(arr):
    out=[]
    for x in arr:
        mark = " ⚠ critical" if x.get("critical") else ""
        out.append(f"- [ ] **{x['type']}**: {x['text']}{mark}")
    return "\n".join(out) if out else "- [ ] （tickets.json#tier_2_functional が空。要記入）"
tier2 = fmt_ears(ac.get("tier_2_functional",[]))
tier3 = "\n".join(f"- [ ] {x}" for x in ac.get("tier_3_regression",[])) or "- [ ] （tier_3 が空）"

# Test scenarios
ts = t.get("test_scenarios_inline", [])
test_sect_lines=[]
for i,s in enumerate(ts, 1):
    test_sect_lines.append(f"### {i}. {s.get('name','-')}")
    test_sect_lines.append("```")
    for step in s.get("steps", []):
        test_sect_lines.append(f"  - {step}")
    test_sect_lines.append(f"  期待値: {s.get('expected','-')}")
    test_sect_lines.append("```")
test_sect = "\n".join(test_sect_lines) if test_sect_lines else "（test_scenarios_inline が空）"

# Screen mocks
scr = t.get("screen_ids") or []
screen_mocks = ", ".join([f"\`06_mockups/.../{s}.html\`" for s in scr]) if scr else "（UI 無し）"

# Substitute
out = tmpl
subs = {
  "{{BRANCH}}": branch,
  "{{NOW}}": datetime.datetime.now().isoformat(),
  "{{TASK_ID}}": tid,
  "{{TITLE}}": title,
  "{{BLOCKING_FLAG}}": "★ BLOCKING TASK ★" if t.get("blocking") else "",
  "{{GROUP}}": t["group"],
  "{{PHASE}}": t["phase"],
  "{{WAVE}}": str(t["wave"]),
  "{{ASSIGNED_EMPLOYEE}}": t["assigned_employee"],
  "{{DELIVERABLE_LAYER}}": t["deliverable_layer"],
  "{{CATEGORY}}": t["category"],
  "{{LABEL}}": t["label"],
  "{{SCREEN_IDS}}": ", ".join(scr) or "–",
  "{{ENTITY_IDS}}": ", ".join(t.get("entity_ids") or []) or "–",
  "{{FEATURE_IDS}}": ", ".join(t.get("feature_ids") or []) or "–",
  "{{DEPENDS_ON}}": ", ".join(t.get("depends_on") or []) or "–",
  "{{HUMAN_H}}": str(t["estimate_hours_human"]),
  "{{AI_H}}": str(t["estimate_hours_ai"]),
  "{{WALL_H}}": str(t["wall_clock_h_ai"]),
  "{{ACCEL_FACTOR}}": str(t["ai_acceleration_factor"]),
  "{{REVIEW_H}}": str(t["human_review_h"]),
  "{{SCREEN_MOCKS}}": screen_mocks,
  "{{FILES_NEW}}": files_new,
  "{{FILES_MODIFY}}": files_modify,
  "{{FILES_SHARED_READ}}": files_shared,
  "{{FILES_FORBIDDEN}}": files_forbid,
  "{{TIER_1}}": tier1,
  "{{TIER_2}}": tier2,
  "{{TIER_3}}": tier3,
  "{{TEST_SCENARIOS}}": test_sect
}
for k,v in subs.items():
    out = out.replace(k, str(v))

print(out)
PY
}

case "${1:-}" in
  --preview)
    [ -z "${2:-}" ] && { echo "Usage: dispatch.sh --preview <TASK_ID>"; exit 1; }
    generate "$2"
    ;;
  --all-preview)
    OUT="/tmp/atelier-jit-preview"
    mkdir -p "$OUT"
    count=0
    for tid in $(jq -r '.tasks[].id' "$TICKETS"); do
      generate "$tid" > "$OUT/${tid}-CLAUDE.md"
      count=$((count+1))
    done
    echo "✓ Generated $count CLAUDE.md previews to $OUT/"
    ;;
  --help|"")
    cat <<EOF
Atelier JIT Dispatcher
Usage:
  dispatch.sh <TASK_ID>              生成して Claude Code を起動
  dispatch.sh --preview <TASK_ID>    標準出力に CLAUDE.md を吐く
  dispatch.sh --all-preview          全 190 タスクを /tmp/atelier-jit-preview/ に書き出し
  dispatch.sh --help                 このヘルプ

例:
  ./dispatch.sh T-A-18
  ./dispatch.sh --preview T-F-07 | less
EOF
    ;;
  *)
    TID="$1"
    TMPDIR=$(mktemp -d "/tmp/atelier-dispatch-${TID}-XXXXXX")
    generate "$TID" > "$TMPDIR/CLAUDE.md"
    echo "✓ Generated: $TMPDIR/CLAUDE.md"
    echo ""
    echo "次の手順："
    echo "  1. cd $ROOT"
    echo "  2. git checkout -b \$(grep '実装ブランチ:' $TMPDIR/CLAUDE.md | sed 's/.*: //')"
    echo "  3. cp $TMPDIR/CLAUDE.md ./CLAUDE.md   # ルートに配置（一時的・実装後に削除）"
    echo "  4. claude  # Claude Code を起動して「進めて」"
    echo "  5. 完了後: rm CLAUDE.md && git push"
    ;;
esac
