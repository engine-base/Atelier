#!/usr/bin/env bash
# plan_gate.sh — ジャーニー計画が「表面をなぞっただけ」でないことを機械検査する。
#
# なぜ必要か:
#   SKILL.md / planning-method.md に「表面積から導出せよ」「CRUD を一通り」「Roles を
#   埋めよ」と書いてあっても、散文の指示は飛ばせる。実際に 77画面/140API操作の
#   プロジェクトで 38 行の粗い計画を書き、「商品ページ→カート→購入手続き→確定」を
#   1 行に潰して実行に入った事故が起きた。よって [3] 実行の前にこのゲートを通す。
#
# 使い方:
#   bash plan_gate.sh <plan.json> <surface.json>
#   exit 0 = 実行に進んでよい / exit 2 = 計画が不足 (実行禁止)
set -euo pipefail

PLAN="${1:-}"
SURFACE="${2:-}"

if [[ -z "$PLAN" || -z "$SURFACE" ]]; then
  echo "usage: plan_gate.sh <plan.json> <surface.json>" >&2
  exit 2
fi
if [[ ! -f "$PLAN" ]]; then
  echo "FAIL: plan.json がありません: $PLAN" >&2
  exit 2
fi
if [[ ! -f "$SURFACE" ]]; then
  echo "FAIL: surface.json がありません。先に derive_surface.py を実行してください: $SURFACE" >&2
  exit 2
fi

python3 - "$PLAN" "$SURFACE" <<'PY'
import json, re, sys

plan_path, surface_path = sys.argv[1], sys.argv[2]
plan = json.load(open(plan_path, encoding="utf-8"))
surface = json.load(open(surface_path, encoding="utf-8"))

rows = plan.get("rows", [])
discovered = plan.get("discovered", {}) or {}
role_meta = discovered.get("role_meta", {}) or {}
roles = discovered.get("roles", []) or []

fails, warns = [], []

# --- 1. 行数が表面積の下限を満たすか (件数は入力ではなく出力) ---
min_rows = surface.get("min_rows", 0)
if surface.get("counts", {}).get("screens", 0) == 0:
    manual = discovered.get("surface_manual")
    if not manual:
        fails.append("表面積を自動検出できず、discovered.surface_manual の宣言もありません")
    else:
        min_rows = int(manual.get("min_rows", 0))
if len(rows) < min_rows:
    fails.append(
        f"行数 {len(rows)} が表面積から導出した下限 {min_rows} 未満。"
        f" 根拠: {surface.get('rationale','')}"
    )

# --- 2. Roles シートの中身 (provides/consumes が依存順の根拠) ---
if not roles:
    fails.append("discovered.roles が空です (ロールを列挙していない)")
for r in roles:
    meta = role_meta.get(r, {}) or {}
    missing = [k for k in ("how_to_enter", "goal", "provides", "consumes") if not meta.get(k)]
    if missing:
        fails.append(f"role_meta[{r}] の {'/'.join(missing)} が未記入 (Roles シートが空になる)")

# --- 3. 1行に操作を潰していないか ---
squashed = []
for r in rows:
    steps = str(r.get("steps", ""))
    arrows = steps.count("→") + steps.count("->")
    if arrows >= 4:
        squashed.append(f"{r.get('id')} (steps に遷移 {arrows} 個)")
if squashed:
    fails.append(
        "1 行に複数操作を潰しています (通しではなく要約になる): " + ", ".join(squashed[:10])
        + (f" 他{len(squashed)-10}件" if len(squashed) > 10 else "")
    )

# --- 4. 分岐 8 種が織り込まれているか (§8) ---
kinds = set(surface.get("branch_kinds", []))
used = {str(r.get("branch", "")).strip() for r in rows}
missing_kinds = sorted(kinds - used)
if missing_kinds:
    fails.append("分岐種別が未使用: " + ", ".join(missing_kinds))

# --- 5. 実結果を観察しているか (§9) ---
OBSERVE = re.compile(r"反映|状態|遷移|通知|メール|DB|一覧に出|見えなく|届く|記録|残る|増え|減")
weak = [r.get("id") for r in rows if not OBSERVE.search(str(r.get("expected", "")))]
if len(weak) > len(rows) * 0.2:
    fails.append(
        f"expected に実結果(状態遷移/通知/メール/相手ロール反映/DB)の記述が無い行が "
        f"{len(weak)}/{len(rows)} 件。「画面が出た」で終わらせないこと"
    )
elif weak:
    warns.append(f"expected が弱い行 {len(weak)} 件: " + ", ".join(map(str, weak[:8])))

# --- 6. CRUD を一通り回しているか (§7.5) ---
CREATE = re.compile(r"作成|登録|出品|発行|申請|投稿|追加")
UPDATE = re.compile(r"編集|変更|更新|切り替|承認|却下")
DELETE = re.compile(r"削除|停止|取り下げ|無効|失効|キャンセル|剥奪|アーカイブ")
text_all = " ".join(f"{r.get('action','')} {r.get('expected','')}" for r in rows)
for label, rx in (("作成", CREATE), ("編集", UPDATE), ("削除/失効", DELETE)):
    if not rx.search(text_all):
        fails.append(f"CRUD の {label} を行うジャーニー行が 1 つもありません (§7.5)")

# --- 7. depends_on の健全性 (DAG) ---
ids = {r.get("id") for r in rows}
for r in rows:
    for d in r.get("depends_on", []) or []:
        if d not in ids:
            fails.append(f"{r.get('id')} の depends_on '{d}' が存在しません")
# 自己参照・循環の粗検出
order_by_id = {r.get("id"): r.get("order", 0) for r in rows}
for r in rows:
    for d in r.get("depends_on", []) or []:
        if d in order_by_id and order_by_id[d] >= r.get("order", 0):
            warns.append(f"{r.get('id')} は依存先 {d} より order が先か同じです (依存順が崩れている)")

# --- 8. 全ロールが onboard/auth から outcome まで通っているか ---
by_role = {}
for r in rows:
    by_role.setdefault(r.get("role"), set()).add(r.get("phase"))
for r in roles:
    phases = by_role.get(r, set())
    if "outcome" not in phases:
        fails.append(f"ロール {r} に outcome (そのロールの最終成果) の行がありません")
    if not ({"onboard", "auth"} & phases):
        warns.append(f"ロール {r} に onboard/auth の行がありません (本人として入っていない)")

print(f"行数            = {len(rows)} (下限 {min_rows})")
print(f"ロール          = {len(roles)}")
print(f"分岐種別        = {len(used & kinds)}/{len(kinds)}")
for w in warns:
    print(f"WARN: {w}")
for f in fails:
    print(f"FAIL: {f}")

if fails:
    print("STATUS: 計画が不足（実行に進んではならない）")
    sys.exit(2)
print("STATUS: 計画OK（[3] 実行に進んでよい）")
PY
