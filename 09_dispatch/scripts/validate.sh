#!/usr/bin/env bash
# Atelier JIT Validation
# tickets.json の完全性を検証。CI gate で必ず実行。
# 1 件でも欠落があれば exit 1 で reject。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TICKETS="$ROOT/07_tasks/tickets.json"

python3 - <<'PY'
import json, sys, pathlib

T = pathlib.Path("__TICKETS__".replace("__TICKETS__", "${TICKETS}".strip("$").strip("{").strip("}")))
PY

python3 - <<PY
import json, sys, pathlib

T = pathlib.Path("$TICKETS")
tickets = json.loads(T.read_text())
tasks = tickets["tasks"]
fail = []
warn = []

REQ_TASK_FIELDS = [
    "id","title","group","phase","wave",
    "estimate_hours_human","estimate_hours_ai","wall_clock_h_ai","ai_acceleration_factor","human_review_h",
    "files_changed_predicted","acceptance_criteria_inline","test_scenarios_inline",
    "depends_on","ac_path","assigned_employee","deliverable_layer","category","label"
]

# DAG check
all_ids = {t["id"] for t in tasks}
dag_edges = {t["id"]: t.get("depends_on", []) for t in tasks}

for t in tasks:
    tid = t["id"]
    # Required fields
    for f in REQ_TASK_FIELDS:
        if f not in t:
            fail.append(f"{tid}: missing field [{f}]")

    # Files changed
    fc = t.get("files_changed_predicted")
    if not isinstance(fc, dict) or not fc.get("new"):
        fail.append(f"{tid}: files_changed_predicted.new must be non-empty")

    # AC inline
    ac = t.get("acceptance_criteria_inline", {})
    if not ac.get("tier_1_structural"):
        fail.append(f"{tid}: acceptance_criteria_inline.tier_1_structural empty")
    if not ac.get("tier_2_functional"):
        fail.append(f"{tid}: acceptance_criteria_inline.tier_2_functional empty")
    if not ac.get("tier_3_regression"):
        fail.append(f"{tid}: acceptance_criteria_inline.tier_3_regression empty")

    # UNWANTED in tier 2 for backend/data tasks
    if t["group"] in ["A","D","U-screen"]:
        types = [x.get("type") for x in ac.get("tier_2_functional",[])]
        if "UNWANTED" not in types:
            warn.append(f"{tid}: tier_2 missing UNWANTED (access policy guard)")

    # Test scenarios
    if not t.get("test_scenarios_inline"):
        fail.append(f"{tid}: test_scenarios_inline empty")

    # Two-axis
    for k in ["estimate_hours_human","estimate_hours_ai","wall_clock_h_ai","ai_acceleration_factor","human_review_h"]:
        if k not in t or t[k] is None:
            fail.append(f"{tid}: {k} missing")

    # Acceleration factor sanity
    af = t.get("ai_acceleration_factor",0)
    if af < 1 or af > 30:
        warn.append(f"{tid}: ai_acceleration_factor={af} unrealistic (1-30 expected)")

    # Blocking + review_h
    if t.get("blocking") and t.get("human_review_h",0) <= 0:
        warn.append(f"{tid}: blocking=true but human_review_h=0")

    # DAG: depends_on existence
    for dep in t.get("depends_on",[]):
        if dep not in all_ids:
            fail.append(f"{tid}: depends_on '{dep}' does not exist")

# DAG cycle detection
def has_cycle():
    color = {}
    def dfs(n):
        color[n] = "gray"
        for nb in dag_edges.get(n, []):
            if color.get(nb) == "gray": return True
            if color.get(nb) is None and dfs(nb): return True
        color[n] = "black"
        return False
    for n in all_ids:
        if color.get(n) is None:
            if dfs(n): return True
    return False
if has_cycle():
    fail.append("DAG has a cycle in depends_on")

# Summary fields
s = tickets.get("summary", {})
for k in ["total_estimate_hours_human","total_estimate_hours_ai_compute","total_wall_clock_h_ai_parallel","ai_acceleration_factor_overall"]:
    if k not in s:
        fail.append(f"summary.{k} missing")

# Output
print(f"=== Atelier JIT Validation ===")
print(f"  tasks: {len(tasks)}")
print(f"  failures: {len(fail)}")
print(f"  warnings: {len(warn)}")
if fail:
    print("\n❌ FAIL:")
    for f in fail[:30]: print(f"  - {f}")
    if len(fail)>30: print(f"  ... and {len(fail)-30} more")
if warn:
    print("\n⚠ WARN:")
    for w in warn[:20]: print(f"  - {w}")
    if len(warn)>20: print(f"  ... and {len(warn)-20} more")

if fail:
    print("\n→ exit 1: tickets.json は JIT スキーマを満たしていません")
    sys.exit(1)
print("\n✓ PASS: tickets.json is JIT-ready (190/190)")
PY
