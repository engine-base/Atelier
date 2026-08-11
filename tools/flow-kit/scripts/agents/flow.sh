#!/usr/bin/env bash
# .flow/state.json の更新ヘルパ (3 役セッションのバトン管理)。
# 使い方は docs/agents/protocol.md を参照。JSON を手で編集しないこと。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="$REPO/.flow"
STATE="$STATE_DIR/state.json"
mkdir -p "$STATE_DIR" "$STATE_DIR/reports"

cmd="${1:-status}"
shift || true

python3 - "$STATE" "$cmd" "$@" << 'PYEOF'
import json
import sys
from datetime import datetime, timezone

state_path, cmd, *args = sys.argv[1:]
ROLES = ("pm", "dev", "qa")


def load():
    try:
        with open(state_path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {
            "task": None,
            "holder": None,
            "phase": "idle",
            "handoff_sent": True,
            "updated_at": None,
            "log": [],
        }


def save(st, event):
    st["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    st.setdefault("log", []).append({"at": st["updated_at"], "event": event})
    st["log"] = st["log"][-200:]
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2)
    print(f"flow: {event}")


st = load()

if cmd == "take":
    if len(args) < 2:
        sys.exit("usage: flow.sh take <pm|dev|qa> <task-id> [note]")
    role, task = args[0], args[1]
    if role not in ROLES:
        sys.exit(f"unknown role: {role}")
    note = " ".join(args[2:])
    st.update(task=task, holder=role, phase="working", handoff_sent=False)
    save(st, f"take: {role} が {task} を作業中" + (f" — {note}" if note else ""))
elif cmd == "handoff":
    if len(args) < 3:
        sys.exit('usage: flow.sh handoff <from> <to> "<種別: 要約>"')
    src, dst = args[0], args[1]
    summary = " ".join(args[2:])
    if src not in ROLES or dst not in ROLES:
        sys.exit(f"unknown role: {src} -> {dst}")
    st.update(holder=dst, phase="handed_off", handoff_sent=True)
    save(st, f"handoff: {src} → {dst} | {summary}")
elif cmd == "wait-user":
    note = " ".join(args) or "(内容未記載)"
    st.update(phase="waiting_user", handoff_sent=True)
    save(st, f"wait-user: {note}")
elif cmd == "idle":
    note = " ".join(args) or "(サマリ未記載)"
    st.update(phase="idle", holder=None, handoff_sent=True)
    save(st, f"idle: {note}")
elif cmd == "status":
    print(json.dumps({k: v for k, v in st.items() if k != "log"}, ensure_ascii=False, indent=2))
    for entry in st.get("log", [])[-10:]:
        print(f"  {entry['at']}  {entry['event']}")
else:
    sys.exit(f"unknown command: {cmd} (take|handoff|wait-user|idle|status)")
PYEOF
