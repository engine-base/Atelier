#!/usr/bin/env bash
# ============================================================================
# completion_gate.sh — human-grade-qa「完了」主張の機械的強制ゲート。
#
# なぜ存在するか: 過去、エージェントが SKILL.md の「過大報告禁止」を読んでいても、
# 散文の自己質問を回避して「完璧/完了」と報告し、実際は結果列が全部空(全TC未実施)
# だった事故が反復した。散文の歯止めでは足りない。このスクリプトが結果列を機械集計し、
# planned>0 なら STATUS=未完了 を返して非ゼロ終了する。エージェントは「完了/完璧」の語を
# 出力する直前に必ずこれを走らせ、出力を貼り、STATUS が「完了」でない限りそれらの語を
# 使ってはならない(鉄則0)。
#
# 使い方:
#   bash completion_gate.sh <spec-dir>       # 例: .qa/test-specs   (screens/*.md を集計)
#   bash completion_gate.sh <run-dir>        # state.json があれば優先集計
# 終了コード: 0=完了(planned=0 かつ failed=0) / 2=未完了 / 1=対象なし
# ============================================================================
set -uo pipefail
DIR="${1:-.qa/test-specs}"

python3 - "$DIR" <<'PY'
import sys, os, re, glob, json

d = sys.argv[1]
passed = blocked = failed = planned = 0
source = None

# 1) state.json 優先(あれば正本)
st = None
for cand in (os.path.join(d, "state.json"),
             *glob.glob(os.path.join(d, "**", "state.json"), recursive=True)):
    if os.path.isfile(cand):
        st = cand
        break
if st:
    try:
        data = json.load(open(st, encoding="utf-8"))
        tcs = data.get("tcs") or data.get("test_cases") or []
        for t in tcs:
            s = str(t.get("status", "")).lower()
            ev = t.get("evidence")
            if s == "passed" and ev:
                passed += 1
            elif s == "passed" and not ev:
                # 証拠なき passed は捏造 → planned 扱い(鉄則1)
                planned += 1
            elif s in ("blocked",):
                blocked += 1
            elif s in ("failed", "fail"):
                failed += 1
            else:
                planned += 1
        if tcs:
            source = f"state.json ({st})"
    except Exception:
        st = None

# 2) 結果列(screens/*.md)集計 — state.json が無い/空のとき
if source is None:
    base = d
    if not glob.glob(os.path.join(base, "screens", "*.md")):
        # d 自体が screens かもしれない
        if glob.glob(os.path.join(base, "*.md")):
            files = glob.glob(os.path.join(base, "*.md"))
        else:
            files = glob.glob(os.path.join(base, "screens", "*.md"))
    else:
        files = glob.glob(os.path.join(base, "screens", "*.md"))
    # TC 行 ID の両表記を拾う: `TC-S313-01` / `S-313-01` / `S313-001` / `T-001` 等。
    row = re.compile(r'^\|\s*(?:TC-)?[A-Za-z]+-?\d+-\d+\s*\|')
    for f in files:
        for ln in open(f, encoding="utf-8"):
            if not row.match(ln):
                continue
            cols = [c.strip() for c in ln.split('|')[1:-1]]
            if len(cols) < 9:
                continue
            result = cols[7]  # 結果列
            if re.search(r'PASS|完了|FIXED|✓|○', result):
                passed += 1
            elif re.search(r'BLOCKED', result, re.I):
                blocked += 1
            elif re.search(r'FAIL|NG|×', result, re.I):
                failed += 1
            else:  # 空・未実施・要ブラウザ実操作 等 = 未実行
                planned += 1
    source = f"結果列 screens/*.md ({len(files)} 枚)"

total = passed + blocked + failed + planned
print(f"集計元: {source}")
print(f"全TC N        = {total}")
print(f"PASS(完了)    = {passed}")
print(f"BLOCKED       = {blocked}")
print(f"FAIL          = {failed}")
print(f"未実施(planned)= {planned}")
print(f"内訳表記      : PASS {passed} / BLOCKED {blocked} / FAIL {failed} / 未(planned) {planned} / 全 {total}")

if total == 0:
    print("STATUS: 対象なし (TC が 0 件)")
    sys.exit(1)
if failed > 0 or planned > 0:
    残 = planned + failed
    print(f"STATUS: 未完了（残 {残} 件）")
    print("→ 『完了/完璧/全部終わった/done/perfect/全て完了』等の語を報告に使ってはならない(鉄則0)。")
    print("→ 総括は必ず【未完了（残 " + str(残) + " 件）】と書き、PASS n/BLOCKED m/未 k/全 N の実測内訳を併記する。")
    sys.exit(2)
print("STATUS: 完了 (planned=0 かつ failed=0・全TC PASS/BLOCKED)")
sys.exit(0)
PY
