#!/usr/bin/env python3
"""pipeline-next.py — 「次に起動するスキル」を成果物の有無で機械判定する。

正本: .claude/rules/common/skill-pipeline.yaml（順番・成果物・skip 条件）
状態: .claude/state/pipeline.json（明示の done / skip。理由必須）

  pipeline-next.py                  状況表 + 次に起動するスキルを出す
  pipeline-next.py mark S05 skip --reason "既存モックを流用"
  pipeline-next.py mark S03 done --reason "ADR-012 で staging 確定"
  pipeline-next.py check-staging    selected-stack.json に environments.staging があるか (S03 の done_when)
  pipeline-next.py check-spec-sync  spec-validator (ローカルスキル) の結果ファイルがあるか

各スキルは完了時にこれを走らせ、出力の「→ 次」に進む。人が順番を覚えない。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PIPELINE = ROOT / ".claude/rules/common/skill-pipeline.yaml"
STATE = ROOT / ".claude/state/pipeline.json"
SELECTED_STACK = ROOT / "03_architecture/selected-stack.json"


# ── 依存を増やさない最小 YAML 読み (この形式のファイル専用) ───────────────────
def load_pipeline(path: Path) -> dict:
    try:
        import yaml  # type: ignore

        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except ImportError:
        pass
    # PyYAML が無い環境向けの簡易パーサ (stages の主要キーだけ)
    stages: list[dict] = []
    cur: dict | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        if re.match(r"^  - id:", line):
            cur = {"id": line.split(":", 1)[1].strip()}
            stages.append(cur)
        elif cur is not None and re.match(r"^    \w", line):
            k, _, v = line.strip().partition(":")
            v = v.strip()
            if v.startswith("[") and v.endswith("]"):
                cur[k] = [x.strip() for x in v[1:-1].split(",") if x.strip()]
            elif v.startswith("{") and v.endswith("}"):
                m = re.match(r"\{(\w+):\s*(.+)\}", v)
                if m:
                    inner = m.group(2).strip()
                    cur[k] = {
                        m.group(1): [x.strip() for x in inner[1:-1].split(",")]
                        if inner.startswith("[")
                        else inner
                    }
            elif v in ("true", "false"):
                cur[k] = v == "true"
            else:
                cur[k] = v
        elif line.startswith("cross_cutting:"):
            cur = None
    return {"stages": stages}


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return {"marks": {}}


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _found(pattern: str) -> bool:
    """ROOT からの相対 glob（末尾 / はディレクトリ）。"""
    pat = pattern.rstrip("/")
    return any(True for _ in ROOT.glob(pat))


def exists_any(patterns: list[str]) -> bool:
    return any(_found(p) for p in patterns)


def produces_ok(stage: dict) -> tuple[bool, list[str]]:
    missing = [p for p in stage.get("produces") or [] if not _found(p)]
    return (not missing, missing)


def tickets_have(field: str) -> bool:
    p = ROOT / "07_tasks/tickets.json"
    if not p.exists():
        return False
    tasks = json.loads(p.read_text(encoding="utf-8")).get("tasks") or []
    return bool(tasks) and all(t.get(field) for t in tasks)


def skip_reason(stage: dict, state: dict) -> str | None:
    mark = state["marks"].get(stage["id"])
    if mark and mark.get("status") == "skip":
        return f"明示 skip: {mark.get('reason', '')}"
    cond = stage.get("skip_if") or {}
    if isinstance(cond, dict):
        if cond.get("any_exists") and exists_any(list(cond["any_exists"])):
            return "成果物が既にある"
        if cond.get("tickets_have") and tickets_have(str(cond["tickets_have"])):
            return f"tickets.json に {cond['tickets_have']} が揃っている"
        if cond.get("project_flag"):
            flags = state.get("project_flags") or {}
            if flags.get(str(cond["project_flag"])):
                return f"project_flag {cond['project_flag']}"
    return None


def status_of(stage: dict, state: dict) -> tuple[str, str]:
    """(status, detail): done / skip / repeat / todo."""
    mark = state["marks"].get(stage["id"])
    if mark and mark.get("status") == "done":
        return "done", f"明示 done: {mark.get('reason', '')}"
    sk = skip_reason(stage, state)
    if sk:
        return "skip", sk
    if stage.get("repeat"):
        return "repeat", f"ループ段 ({stage['repeat']})"
    ok, missing = produces_ok(stage)
    if not ok:
        return "todo", "無い成果物: " + ", ".join(missing)
    if stage.get("done_when"):
        cmd = str(stage["done_when"])
        if "$" in cmd:  # per-task 等、引数が要る完了条件はここでは走らせない
            return "gate", f"成果物あり。完了条件: {cmd}"
        ok = _run_gate(cmd)
        if ok:
            return "done", f"成果物あり・完了条件 PASS: {cmd}"
        return "gate", f"成果物あり・完了条件 FAIL: {cmd}"
    return "done", "成果物あり"


def _run_gate(cmd: str) -> bool:
    """done_when を実際に走らせる (exit 0 = PASS)。成果物の有無だけで done にしない。"""
    try:
        r = subprocess.run(
            cmd, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=180, check=False
        )
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def cmd_status(pipe: dict, state: dict) -> int:
    print("== skill pipeline (.claude/rules/common/skill-pipeline.yaml) ==")
    nxt: dict | None = None
    for st in pipe["stages"]:
        s, d = status_of(st, state)
        mark = {"done": "✓", "skip": "–", "repeat": "↻", "gate": "◐", "todo": "☐"}[s]
        opt = " (skip 可)" if st.get("optional") else ""
        print(f"  {mark} {st['id']:5} {st.get('skill', ''):26} {st.get('title', '')}{opt}")
        print(f"        {d}")
        if nxt is None and s in ("todo", "gate") and not st.get("optional"):
            nxt = st
    if nxt is None:
        rep = [st for st in pipe["stages"] if st.get("repeat")]
        print("\n→ 一直線の段は全部揃っています。ループ段を回してください:")
        for st in rep:
            print(
                f"   ↻ {st['id']} {st.get('skill')} ({st.get('repeat')}) — 完了条件: {st.get('done_when', '-')}"
            )
        return 0
    print(
        f"\n→ 次: {nxt['id']} **{nxt.get('skill')}**{' (' + nxt['mode'] + ' モード)' if nxt.get('mode') else ''} — {nxt.get('title', '')}"
    )
    if nxt.get("done_when"):
        print(f"   完了条件: {nxt['done_when']}")
    print(
        f"   起動: Skill ツールで `{nxt.get('skill')}` を起動。終わったら再度 `python3 scripts/ci/pipeline-next.py`"
    )
    return 0


def cmd_mark(state: dict, stage_id: str, status: str, reason: str) -> int:
    if not reason.strip():
        print("✗ --reason が要る（理由なしの done / skip は捏造と同じ）")
        return 2
    state["marks"][stage_id] = {"status": status, "reason": reason, "at": date.today().isoformat()}
    save_state(state)
    print(f"✓ {stage_id} を {status} にしました: {reason}")
    return 0


def cmd_check_staging() -> int:
    if not SELECTED_STACK.exists():
        print("✗ 03_architecture/selected-stack.json が無い")
        return 2
    data = json.loads(SELECTED_STACK.read_text(encoding="utf-8"))
    env = (data.get("environments") or {}).get("staging")
    if not env:
        print(
            "✗ selected-stack.json に environments.staging が無い (GAP-246)。architecture-design の STEP 4 で確定する"
        )
        return 2
    needed = ("provisioned_by", "data_policy", "owner")
    missing = [k for k in needed if not env.get(k)]
    if missing:
        print(
            f"✗ environments.staging に {missing} が無い（本番同一の migration/deploy で作れること・データ方針・誰が用意するか）"
        )
        return 2
    if str(env.get("decision", "")).lower() != "approved":
        print(
            f"✗ staging は提案止まり (decision={env.get('decision')!r})。経営者が ADR-021 を承認して "
            "decision を approved にするまで S03 は完了しない"
        )
        return 2
    print(f"✓ staging 確定: {env.get('recommended_option', '')} / owner={env.get('owner', '')}")
    return 0


def cmd_check_spec_sync() -> int:
    # spec-sync-orchestrator (ローカルスキル) は spec-validator の結果を残す。無ければ未実行
    cands = list(ROOT.glob(".qa/spec-sync/**/result.json")) + list(
        ROOT.glob("docs/spec-sync/*.json")
    )
    if not cands:
        print("✗ spec-sync の結果が無い (spec-sync-orchestrator を起動して spec-validator を通す)")
        return 2
    latest = max(cands, key=lambda p: p.stat().st_mtime)
    data = json.loads(latest.read_text(encoding="utf-8"))
    ok = str(data.get("status", "")).upper() in ("PASS", "OK")
    print(
        ("✓" if ok else "✗")
        + f" spec-sync 最新: {latest.relative_to(ROOT)} status={data.get('status')}"
    )
    return 0 if ok else 2


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "cmd",
        nargs="?",
        default="status",
        choices=["status", "mark", "check-staging", "check-spec-sync"],
    )
    ap.add_argument("stage", nargs="?", default="")
    ap.add_argument("value", nargs="?", default="")
    ap.add_argument("--reason", default="")
    a = ap.parse_args()
    if a.cmd == "check-staging":
        return cmd_check_staging()
    if a.cmd == "check-spec-sync":
        return cmd_check_spec_sync()
    pipe = load_pipeline(PIPELINE)
    state = load_state()
    if a.cmd == "mark":
        if a.value not in ("done", "skip"):
            ap.error("mark <stage> done|skip --reason ...")
        return cmd_mark(state, a.stage, a.value, a.reason)
    return cmd_status(pipe, state)


if __name__ == "__main__":
    sys.exit(main())
