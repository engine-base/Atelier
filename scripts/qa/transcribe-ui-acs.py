#!/usr/bin/env python3
"""GAP-103 解消 — UI タスクの tier_2 AC を screens/features から機械転写する。

task-decomposition 絶対ルール10 に従い、テンプレコピペだった UI タスク
(deliverable_layer=ui) の tier_2_functional を以下で再生成する:

- screens.json (画面台帳) の fields / actions / states / transitions を
  1 要素 = 1 AC で EARS 形式に転写 (画面固有 AC)
- features.json の happy_path / api_endpoints を転写 (同一画面を共有する
  サブタスク同士の差別化 — 例: T-UC-08 と T-UC-09 は feature が異なる)
- UNWANTED (4xx/5xx inline error + toast) は Gate #2 validator の
  必須ガードとして常に末尾へ残す

再実行可能 (冪等)。実行後は ./09_dispatch/scripts/validate.sh で PASS を確認する。

usage: python3 scripts/qa/transcribe-ui-acs.py [--root <repo>] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

UNWANTED_GUARD: dict[str, Any] = {
    "type": "UNWANTED",
    "text": "If the API returns 4xx/5xx, the system shall show an inline error and emit a toast",
    "critical": True,
}


def screen_acs(sid: str, screens: dict[str, Any]) -> list[dict[str, str]]:
    s = screens.get(sid)
    if not s:
        return []
    acs: list[dict[str, str]] = []
    mock = s.get("mock_path", "06_mockups")
    for f in s.get("fields", []):
        acs.append(
            {
                "type": "STATE-DRIVEN",
                "text": f"While {sid} is rendered, the system shall display the 「{f}」 element per {mock}",
            }
        )
    for a in s.get("actions", []):
        acs.append(
            {
                "type": "EVENT-DRIVEN",
                "text": (
                    f"When the user invokes 「{a}」 on {sid}, the system shall perform the "
                    "bound real behavior (API call / navigation) and reflect the result in the UI"
                ),
            }
        )
    for st in s.get("states", []):
        acs.append(
            {
                "type": "STATE-DRIVEN",
                "text": f"While {sid} is in the 「{st}」 state, the system shall render that state distinctly per mock",
            }
        )
    for tr in s.get("transitions", []):
        acs.append(
            {
                "type": "EVENT-DRIVEN",
                "text": f"When 「{tr.get('trigger')}」 is activated on {sid}, the system shall navigate to {tr.get('to')}",
            }
        )
    return acs


def feature_acs(fid: str, features: dict[str, Any]) -> list[dict[str, str]]:
    f = features.get(fid)
    if not f:
        return []
    acs: list[dict[str, str]] = []
    for i, step in enumerate(f.get("happy_path") or [], 1):
        acs.append(
            {
                "type": "EVENT-DRIVEN",
                "text": f"The implementation shall realize {fid} ({f.get('name')}) happy path step {i}: {step}",
            }
        )
    for ep in f.get("api_endpoints") or []:
        method, path = ep.get("method"), ep.get("path")
        if method and path:
            acs.append(
                {
                    "type": "EVENT-DRIVEN",
                    "text": (
                        f"When the corresponding UI action fires, the screen shall call "
                        f"{method} {path} and render the documented success response"
                    ),
                }
            )
    return acs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    root = Path(args.root).resolve()

    tickets_path = root / "07_tasks" / "tickets.json"
    tickets = json.loads(tickets_path.read_text())
    screens = {
        s["id"]: s
        for s in json.loads((root / "04_functional_breakdown" / "screens.json").read_text())[
            "items"
        ]
    }
    fdata = json.loads((root / "04_functional_breakdown" / "features.json").read_text())
    fitems = fdata["items"] if isinstance(fdata, dict) and "items" in fdata else fdata
    features = {f["id"]: f for f in fitems}

    changed = 0
    for task in tickets["tasks"]:
        ac = task.get("acceptance_criteria_inline")
        if (
            not ac
            or not task.get("screen_ids")
            or task.get("deliverable_layer") not in ("ui", "frontend")
        ):
            continue
        tier2: list[dict[str, Any]] = [
            {
                "type": "UBIQUITOUS",
                "text": (
                    f"The deliverable of {task['id']} 「{task.get('title', '')}」 shall satisfy the "
                    "screen/feature ACs below within this task's scope (files_changed_predicted)"
                ),
            }
        ]
        seen: set[str] = set()
        for sid in task["screen_ids"]:
            for item in screen_acs(sid, screens):
                if item["text"] not in seen:
                    seen.add(item["text"])
                    tier2.append(item)
        for fid in task.get("feature_ids") or []:
            for item in feature_acs(fid, features):
                if item["text"] not in seen:
                    seen.add(item["text"])
                    tier2.append(item)
        tier2.append(dict(UNWANTED_GUARD))
        if ac.get("tier_2_functional") != tier2:
            ac["tier_2_functional"] = tier2
            changed += 1

    print(f"UI tasks rewritten: {changed}")
    if not args.dry_run and changed:
        tickets_path.write_text(json.dumps(tickets, ensure_ascii=False, indent=2) + "\n")
        print(f"written: {tickets_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
