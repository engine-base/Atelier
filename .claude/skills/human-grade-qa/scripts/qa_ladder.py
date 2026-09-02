#!/usr/bin/env python3
"""qa_ladder.py — テスト・ラダー (L1〜L5) の機械ゲート (汎用コピー。プロジェクトでは scripts/ci/qa-ladder.py に置き --spec / --tickets で場所を渡す)。

規約: .claude/rules/common/test-ladder.md

  validate            正本 (test-specs) ↔ tickets.json の両方向整合を検査 (CI / validate.sh から呼ぶ)
  runnable --task ID  そのタスクの L1 行 + そのタスクの merge で解禁される L2 流れを列挙
  gate     --task ID  上記が全部 PASS / 理由つき BLOCKED でなければ非ゼロ終了 (PR 前の関門)
  suggest             タスク列が空の L1 行に、screen_ids で突合した担当タスク候補を出す (後追い適用用)
  levels              段別 (L1〜L5) の集計 + タスク列が空の L1 行数

入力の形:
  - 画面別/技術/AI 行: markdown 表。ヘッダー行の列名で「結果」「タスク」「実行条件」「画面」を引く
      実行条件 = L1 / L2:after=T-A-1,T-U-2 / L3:wave=W3 / L4 / L5  (空 = L1)
  - ジャーニー: <spec>/journeys/plan.json の rows[]。任意の `runnable_after: [task ids]`。
      行 ID `J10-03` → 流れ ID `J-10`
  - tickets.json: tasks[].qa_rows = {"l1": [行 ID], "l2_flows": ["J-10"]}, tasks[].status = todo|in_progress|done

「done」の判定: tasks[].status == "done" / --done で渡された ID / git log の件名に含まれる ID。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SPEC = ROOT / "apps/web/.qa/test-specs"
DEFAULT_TICKETS = ROOT / "07_tasks/tickets.json"

TASK_ID = re.compile(r"\bT-[A-Z]+(?:-[A-Z]+)?-\d+[a-z]?\b")
ROW_ID = re.compile(r"^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{2,3}$")
PASS = re.compile(r"\b(PASS|FIXED)\b|完了")
BLOCKED = re.compile(r"\bBLOCKED\b")
FAIL = re.compile(r"\b(FAIL|NG)\b")
LEVEL = re.compile(r"\bL([1-5])\b")

SPEC_FILES = (
    "screens/*.md",
    "ai-runtime-matrix.md",
    "prod-smoke.md",
    "zero-state.md",
    "mock-fidelity.md",
    "rls-matrix.md",
    "scale-capacity.md",
    "visual-fidelity-audit.md",
)


class Row(dict):
    """1 行 (id / file / result / task / cond / level / screen / item / status)."""


def status_of(result: str) -> str:
    if FAIL.search(result):
        return "failed"
    if BLOCKED.search(result):
        return "blocked"
    if PASS.search(result):
        return "passed"
    return "planned"


def parse_cond(cond: str) -> tuple[int, list[str], str]:
    """実行条件 → (level, after task ids, wave)."""
    cond = (cond or "").strip()
    if not cond:
        return 1, [], ""
    m = LEVEL.search(cond)
    level = int(m.group(1)) if m else 1
    after = TASK_ID.findall(cond)
    wm = re.search(r"wave=([A-Za-z0-9_-]+)", cond)
    return level, after, (wm.group(1) if wm else "")


def _cell(cells: list[str], idx: dict[str, int], key: str) -> str:
    i = idx.get(key)
    return cells[i] if i is not None and i < len(cells) else ""


def load_spec_rows(spec: Path) -> list[Row]:
    rows: list[Row] = []
    files: list[Path] = []
    for pat in SPEC_FILES:
        files.extend(sorted(spec.glob(pat)))
    for fp in files:
        idx: dict[str, int] = {}
        for line in fp.read_text(encoding="utf-8", errors="replace").splitlines():
            if not line.lstrip().startswith("|"):
                idx = {}
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            first = cells[0] if cells else ""
            if not ROW_ID.match(first):
                # ヘッダー行: 列名 → index
                for i, c in enumerate(cells):
                    key = c.replace("*", "").strip()
                    if key in ("結果", "結果列", "status", "Status"):
                        idx["result"] = i
                    elif key in ("タスク", "task", "Task"):
                        idx["task"] = i
                    elif key in ("実行条件", "level", "Level"):
                        idx["cond"] = i
                    elif key in ("画面", "対象", "screen"):
                        idx.setdefault("screen", i)
                    elif key in ("テスト項目", "手順", "内容"):
                        idx.setdefault("item", i)
                    elif key in ("備考", "note"):
                        idx["note"] = i
                continue

            result = _cell(cells, idx, "result")
            level, after, wave = parse_cond(_cell(cells, idx, "cond"))
            rows.append(
                Row(
                    id=first,
                    file=str(fp.relative_to(spec)),
                    result=result,
                    status=status_of(result),
                    task=list(TASK_ID.findall(_cell(cells, idx, "task"))),
                    task_raw=_cell(cells, idx, "task"),
                    level=level,
                    after=after,
                    wave=wave,
                    screen=_cell(cells, idx, "screen"),
                    item=_cell(cells, idx, "item"),
                    note=_cell(cells, idx, "note"),
                )
            )
    return rows


def load_journeys(spec: Path) -> list[dict]:
    p = spec / "journeys" / "plan.json"
    if not p.exists():
        return []
    data = json.loads(p.read_text(encoding="utf-8"))
    return list(data.get("rows") or [])


def flow_id(row_id: str) -> str:
    """J10-03 → J-10 / J-10 → J-10."""
    m = re.match(r"^J-?(\d+)", row_id)
    return f"J-{m.group(1)}" if m else row_id


def load_tasks(tickets: Path) -> dict[str, dict]:
    if not tickets.exists():
        return {}
    data = json.loads(tickets.read_text(encoding="utf-8"))
    tasks = data.get("tasks") or []
    if isinstance(tasks, dict):
        tasks = list(tasks.values())
    return {t["id"]: t for t in tasks if "id" in t}


def done_tasks(tasks: dict[str, dict], extra: list[str]) -> set[str]:
    done = {tid for tid, t in tasks.items() if str(t.get("status", "")).lower() == "done"}
    done.update(extra)
    try:
        subjects = subprocess.run(
            ["git", "log", "--format=%s", "-n", "5000"],
            capture_output=True,
            text=True,
            cwd=ROOT,
            check=False,
        ).stdout
        for m in TASK_ID.findall(subjects):
            if m in tasks:
                done.add(m)
    except OSError:
        pass
    return done


# --------------------------------------------------------------------------- #
def journey_flows(journeys: list[dict]) -> dict[str, dict]:
    """流れ ID → {rows, runnable_after, status 集計}."""
    flows: dict[str, dict] = defaultdict(lambda: {"rows": [], "after": set()})
    for r in journeys:
        fid = flow_id(str(r.get("id", "")))
        flows[fid]["rows"].append(r)
        for t in r.get("runnable_after") or []:
            flows[fid]["after"].add(t)
    return flows


def cmd_validate(spec: Path, tickets: Path) -> int:
    rows = load_spec_rows(spec)
    journeys = load_journeys(spec)
    tasks = load_tasks(tickets)
    flows = journey_flows(journeys)
    row_ids = {r["id"] for r in rows}
    fails: list[str] = []
    warns: list[str] = []

    # tickets → 正本
    with_rows = 0
    for tid, t in tasks.items():
        qa = t.get("qa_rows") or {}
        if not qa:
            continue
        with_rows += 1
        for rid in qa.get("l1") or []:
            if rid not in row_ids:
                fails.append(f"{tid}: qa_rows.l1 の行 {rid} が正本に無い")
        for fid in qa.get("l2_flows") or []:
            if fid not in flows:
                fails.append(f"{tid}: qa_rows.l2_flows の流れ {fid} が journeys/plan.json に無い")
    # 正本 → tickets
    for r in rows:
        for tid in r["task"]:
            if tid not in tasks:
                fails.append(f"{r['file']} {r['id']}: タスク列の {tid} が tickets.json に無い")
        for tid in r["after"]:
            if tid not in tasks:
                fails.append(f"{r['file']} {r['id']}: 実行条件の {tid} が tickets.json に無い")
        if r["task_raw"] and not r["task"]:
            fails.append(
                f"{r['file']} {r['id']}: タスク列 '{r['task_raw']}' がタスク ID の形でない"
            )
    for fid, f in flows.items():
        for tid in f["after"]:
            if tid not in tasks:
                fails.append(f"journeys {fid}: runnable_after の {tid} が tickets.json に無い")
    # 片方向だけの紐づけ (行に task があるのに tickets 側に無い / 逆) は warn
    rows_by_task: dict[str, set[str]] = defaultdict(set)
    for r in rows:
        for tid in r["task"]:
            rows_by_task[tid].add(r["id"])
    for tid, ids in rows_by_task.items():
        declared = set((tasks.get(tid, {}).get("qa_rows") or {}).get("l1") or [])
        missing = ids - declared
        if tid in tasks and missing:
            warns.append(
                f"{tid}: 正本側は担当だが tickets.qa_rows.l1 に無い行 {sorted(missing)[:5]}"
            )
    for tid, t in tasks.items():
        declared = set((t.get("qa_rows") or {}).get("l1") or [])
        extra = declared - rows_by_task.get(tid, set())
        if extra:
            warns.append(f"{tid}: tickets 側は担当だが正本のタスク列に無い行 {sorted(extra)[:5]}")

    l1_no_task = sum(1 for r in rows if r["level"] == 1 and not r["task"])
    print("== qa-ladder validate ==")
    print(
        f"  正本の行 {len(rows)} / 流れ {len(flows)} / タスク {len(tasks)} (qa_rows あり {with_rows})"
    )
    print(f"  タスク列が空の L1 行 {l1_no_task} (後追い適用の残り。suggest で候補を出せる)")
    for w in warns[:20]:
        print(f"  ⚠ {w}")
    if len(warns) > 20:
        print(f"  ⚠ ... 他 {len(warns) - 20} 件")
    for f in fails[:40]:
        print(f"  ✗ {f}")
    if fails:
        print(f"  FAIL: 参照の不整合 {len(fails)} 件 (片方にしか無い ID)")
        return 2
    print("  PASS: 参照の不整合なし")
    return 0


def _runnable(spec: Path, tickets: Path, task: str, extra_done: list[str]) -> dict:
    rows = load_spec_rows(spec)
    journeys = load_journeys(spec)
    tasks = load_tasks(tickets)
    flows = journey_flows(journeys)
    done = done_tasks(tasks, extra_done)
    t = tasks.get(task) or {}
    qa = t.get("qa_rows") or {}
    l1_ids = set(qa.get("l1") or [])
    l1 = [r for r in rows if r["id"] in l1_ids or task in r["task"]]
    # 実行条件で L2 を持つ行 (画面別/AI 正本側の L2 行)
    l2_rows = [
        r
        for r in rows
        if r["level"] == 2
        and r["after"]
        and set(r["after"]) <= (done | {task})
        and task in r["after"]
    ]
    # ジャーニー: runnable_after が {done ∪ task} に収まり、かつ task を含む流れ
    l2_flows = []
    for fid, f in flows.items():
        after = set(f["after"]) | ({task} if fid in (qa.get("l2_flows") or []) else set())
        if not after:
            continue
        if task in after and after <= (done | {task}):
            l2_flows.append((fid, f))
    return {"task": t, "l1": l1, "l2_rows": l2_rows, "l2_flows": l2_flows, "done": done}


def _print_runnable(res: dict, task: str) -> None:
    t = res["task"]
    print(f"== {task} {t.get('title', '(tickets に無い)')} ==")
    print(f"-- L1 (このタスクが merge 前に staging で流す行) {len(res['l1'])} 行")
    for r in res["l1"]:
        print(f"   {r['status']:8} {r['id']:14} {r['file']}  {r['item'][:50]}")
    print(f"-- L2 行 (実行条件が揃った正本の行) {len(res['l2_rows'])} 行")
    for r in res["l2_rows"]:
        print(f"   {r['status']:8} {r['id']:14} after={','.join(r['after'])}")
    print(f"-- L2 流れ (このタスクで揃うジャーニー) {len(res['l2_flows'])} 本")
    for fid, f in res["l2_flows"]:
        st = defaultdict(int)
        for r in f["rows"]:
            st[str(r.get("status", "TODO")).upper()] += 1
        print(f"   {fid:8} rows={len(f['rows'])} {dict(st)} after={sorted(f['after'])}")


def cmd_runnable(spec: Path, tickets: Path, task: str, extra_done: list[str]) -> int:
    _print_runnable(_runnable(spec, tickets, task, extra_done), task)
    return 0


def cmd_gate(spec: Path, tickets: Path, task: str, extra_done: list[str]) -> int:
    res = _runnable(spec, tickets, task, extra_done)
    _print_runnable(res, task)
    problems: list[str] = []
    if not res["task"]:
        problems.append(f"{task} が tickets.json に無い")
    layer = str(res["task"].get("deliverable_layer", ""))
    if not res["l1"] and layer in ("ui", "backend", "integration"):
        problems.append(
            f"{task} ({layer}) に L1 行が 1 行も無い (task-decomposition で qa_rows を書く)"
        )
    for r in res["l1"] + res["l2_rows"]:
        if r["status"] == "passed":
            continue
        if r["status"] == "blocked" and r["note"]:
            continue
        problems.append(f"{r['id']}: {r['status']} (PASS か理由つき BLOCKED が要る)")
    for fid, f in res["l2_flows"]:
        for r in f["rows"]:
            st = str(r.get("status", "TODO")).upper()
            if st == "PASS" or (st == "BLOCKED" and r.get("note")):
                continue
            problems.append(f"{fid} {r.get('id')}: {st} (揃った流れは全行 PASS が要る)")
    print("== gate ==")
    if problems:
        for p in problems[:40]:
            print(f"  ✗ {p}")
        print(f"  BLOCK: {len(problems)} 件。PR を出せない (test-ladder.md §6)")
        return 2
    print("  PASS: L1 全行 + 解禁された L2 が消化済み")
    return 0


def cmd_suggest(spec: Path, tickets: Path) -> int:
    rows = load_spec_rows(spec)
    tasks = load_tasks(tickets)

    def norm(x: str) -> str:
        return re.sub(r"[^A-Z0-9]", "", str(x).upper())

    by_screen: dict[str, list[str]] = defaultdict(list)
    for tid, t in tasks.items():
        for s in t.get("screen_ids") or []:
            by_screen[norm(s)].append(tid)
    print(
        "== suggest (タスク列が空の L1 行 → screen_ids で突合した候補。人が確認してから正本に書く) =="
    )
    n = 0
    for r in rows:
        if r["level"] != 1 or r["task"]:
            continue
        sid = r["id"].rsplit("-", 1)[0]  # SA01-021 / S-A01-021 → SA01
        cands = by_screen.get(norm(sid)) or by_screen.get(norm(r["screen"])) or []
        if cands:
            n += 1
            print(f"  {r['id']:14} {r['file']:28} → {','.join(sorted(set(cands)))}")
    print(f"  候補あり {n} 行")
    return 0


def cmd_levels(spec: Path, tickets: Path) -> int:
    rows = load_spec_rows(spec)
    journeys = load_journeys(spec)
    tasks = load_tasks(tickets)
    tally: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in rows:
        tally[r["level"]][r["status"]] += 1
        tally[r["level"]]["total"] += 1
    l1_no_task = sum(1 for r in rows if r["level"] == 1 and not r["task"])
    jst = defaultdict(int)
    for r in journeys:
        jst[str(r.get("status", "TODO")).upper()] += 1
    with_rows = sum(1 for t in tasks.values() if t.get("qa_rows"))
    print("== levels ==")
    for lv in range(1, 6):
        t = tally.get(lv, {})
        print(
            f"  L{lv}  全 {t.get('total', 0):4} / PASS {t.get('passed', 0):4} / BLOCKED {t.get('blocked', 0):3}"
            f" / FAIL {t.get('failed', 0):3} / 未判定 {t.get('planned', 0):4}"
        )
    print(f"  L2 ジャーニー行 {sum(jst.values())} {dict(jst)}")
    print(f"  タスク列が空の L1 行 {l1_no_task} / qa_rows を持つタスク {with_rows}/{len(tasks)}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("cmd", choices=["validate", "runnable", "gate", "suggest", "levels"])
    ap.add_argument("--spec", default=str(DEFAULT_SPEC))
    ap.add_argument("--tickets", default=str(DEFAULT_TICKETS))
    ap.add_argument("--task", default="")
    ap.add_argument("--done", default="", help="完了扱いにするタスク ID (カンマ区切り)")
    a = ap.parse_args()
    spec, tickets = Path(a.spec), Path(a.tickets)
    extra = [x for x in a.done.split(",") if x]
    if a.cmd == "validate":
        return cmd_validate(spec, tickets)
    if a.cmd == "suggest":
        return cmd_suggest(spec, tickets)
    if a.cmd == "levels":
        return cmd_levels(spec, tickets)
    if not a.task:
        ap.error("--task T-x-y が要る")
    if a.cmd == "runnable":
        return cmd_runnable(spec, tickets, a.task, extra)
    return cmd_gate(spec, tickets, a.task, extra)


if __name__ == "__main__":
    sys.exit(main())
