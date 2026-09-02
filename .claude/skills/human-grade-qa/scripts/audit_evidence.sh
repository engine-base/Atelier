#!/usr/bin/env bash
# audit_evidence.sh — 捏造PASS検出ゲート
#
# 「テストしていないのに passed と書く」を機械的に潰すための自己監査。
# state.json を走査し、status=passed なのに evidence (screenshots/db_checks/network) を
# 1 つも持たない TC = 「未証明PASS」を検出する。1 件でもあれば非ゼロ終了する。
#
# 使い方:
#   scripts/audit_evidence.sh <run-dir|state.json>
#   scripts/audit_evidence.sh .qa/runs/2026-06-03-full
#
# 運用ルール (SKILL.md STEP 3.5):
#   - レポート発行 (render_report.sh) の前に必ず実行する。
#   - 未証明PASS が出たら、その TC を status=untested(=planned) に戻すか、
#     実際に実行して証拠を取得してから passed にする。捏造のまま report してはならない。
#   - exit 0: 全 passed に証拠あり / exit 2: 未証明PASS あり / exit 1: 入力エラー
set -euo pipefail

arg="${1:?usage: audit_evidence.sh <run-dir|state.json>}"
if [ -d "$arg" ]; then state="${arg}/state.json"; else state="$arg"; fi
[ -f "$state" ] || { echo "[audit] state.json が見つかりません: $state" >&2; exit 1; }
command -v jq >/dev/null || { echo "[audit] jq が必要です" >&2; exit 1; }

# evidence の実体判定: screenshots か db_checks が 1 件以上、または network が非空文字列。
unproven_filter='
  [ .features[].cases[]
    | select(.status=="passed")
    | select(
        ((.evidence.screenshots // []) | length) == 0 and
        ((.evidence.db_checks   // []) | length) == 0 and
        ((.evidence.network // "") == "")
      )
    | {id, title, severity, screen} ]
'

unproven_json="$(jq -c "$unproven_filter" "$state")"
count="$(printf '%s' "$unproven_json" | jq 'length')"

passed_total="$(jq '[.features[].cases[] | select(.status=="passed")] | length' "$state")"

if [ "$count" -eq 0 ]; then
  echo "[audit] OK: passed ${passed_total} 件すべてに証拠 (screenshot/DB/network) があります。"
  exit 0
fi

echo "[audit] ✗ 未証明PASS ${count} / passed ${passed_total} 件 — 証拠の無い PASS は捏造とみなします。" >&2
printf '%s\n' "$unproven_json" | jq -r '.[] | "  - \(.id) [\(.severity)] \(.screen // "") \(.title)"' >&2
echo "[audit] 対処: 該当 TC を実際に実行して evidence を記録するか、status を planned に戻してください。" >&2
exit 2
