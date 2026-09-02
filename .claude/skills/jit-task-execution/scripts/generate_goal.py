#!/usr/bin/env python3
"""generate per-task /goal text from tickets.json + JIT CLAUDE.md.task.

Usage:
  python3 generate_goal.py <TASK_ID> [--tickets PATH]

tickets.json は引数 --tickets で指定 (default: 07_tasks/tickets.json from cwd)。
出力は標準出力。コピペして `/goal` コマンドに投入する。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def format_bullets(items: list, indent: int = 4) -> str:
    """tier_1_structural / tier_3_regression は list[str]、tier_2_functional は list[dict]."""
    spaces = " " * indent
    lines = []
    for item in items:
        if isinstance(item, dict):
            kind = item.get("type", "")
            text = item.get("text", "")
            lines.append(f"{spaces}- [{kind}] {text}")
        else:
            lines.append(f"{spaces}- {item}")
    return "\n".join(lines) if lines else f"{spaces}(none)"


def format_files(files: list, indent: int = 2) -> str:
    spaces = " " * indent
    if not files:
        return f"{spaces}(none)"
    return "\n".join(f"{spaces}- {f}" for f in files)


def format_test_scenarios(scenarios: list, indent: int = 2) -> str:
    spaces = " " * indent
    if not scenarios:
        return f"{spaces}(none)"
    out = []
    for i, s in enumerate(scenarios, 1):
        out.append(f"{spaces}{i}. {s.get('name', '')}")
        for step in s.get("steps", []):
            out.append(f"{spaces}   - step: {step}")
        out.append(f"{spaces}   - expected: {s.get('expected', '')}")
    return "\n".join(out)


def build_goal(task: dict) -> str:
    fcp = task.get("files_changed_predicted", {})
    ac = task.get("acceptance_criteria_inline", {})
    new_modify = (fcp.get("new") or []) + (fcp.get("modify") or [])
    return f"""タスク {task["id"]} "{task["title"]}" の絶対ゴール

============================================
[共通の徹底ルール] (全タスク共通 / 違反 = 実装中止)
============================================
1. selected-stack.json の確定済技術を必ず使う
   代替・placeholder・「あとで」「動けばいい」は禁止
2. acceptance_criteria_inline の定量条件 (80%/0-error/100%) を絶対に下げない
3. files_changed_predicted の new/modify を 1 文字も逸脱しない
   逸脱が必要なら tickets.json 更新 PR を先行
4. CI gate 10 種は実体実装で全 PASS (soft-pass / || true で吞まない)
5. 仕様変更が必要なら手を止めて tickets.json を更新する

============================================
[このタスク固有]
============================================
Group / Phase / Wave: {task.get("group", "")} / {task.get("phase", "")} / W{task.get("wave", "")}
担当: {task.get("assigned_employee", "")}
Depends on: {", ".join(task.get("depends_on", [])) or "(none)"}

editable (このブランチで新規/編集 OK):
{format_files(new_modify)}

shared_read (参照のみ・編集禁止):
{format_files(fcp.get("shared_read") or [])}

forbidden (他タスク専有・絶対に触れない):
{format_files(fcp.get("forbidden") or [])}

3-tier AC (全 PASS 必須):
  Tier 1 structural:
{format_bullets(ac.get("tier_1_structural") or [])}

  Tier 2 functional (EARS 5 形式):
{format_bullets(ac.get("tier_2_functional") or [])}

  Tier 3 regression (v3-gate.yml 10 種):
{format_bullets(ac.get("tier_3_regression") or [])}

test_scenarios:
{format_test_scenarios(task.get("test_scenarios_inline") or [])}

============================================
[逸脱検出]
============================================
- 上記 editable 以外のファイルを touch した瞬間 → STOP
- 上記 AC を満たさずに「動いた」と判断した瞬間 → STOP
- 「あとで」「TODO」「placeholder」を口にした瞬間 → gap tracker 登録
- selected-stack と異なる技術を選んだ瞬間 → STOP
- このゴールから逸脱した瞬間 → S-E01 escalation
"""


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate per-task /goal text")
    parser.add_argument("task_id", help="e.g. T-F-07")
    parser.add_argument(
        "--tickets",
        default="07_tasks/tickets.json",
        help="path to tickets.json",
    )
    args = parser.parse_args()

    tickets_path = Path(args.tickets)
    if not tickets_path.exists():
        print(f"ERROR: {tickets_path} not found", file=sys.stderr)
        return 1

    data = json.loads(tickets_path.read_text(encoding="utf-8"))
    task = next(
        (t for t in data.get("tasks", []) if t.get("id") == args.task_id), None
    )
    if not task:
        print(f"ERROR: task {args.task_id} not found in {tickets_path}", file=sys.stderr)
        return 1

    print(build_goal(task))
    return 0


if __name__ == "__main__":
    sys.exit(main())
