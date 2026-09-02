#!/usr/bin/env bash
# render_report.sh — state.json から final.html / final.json / final.md を生成（日本語・読み物寄り）
# Usage: render_report.sh <run-dir> <out-dir>
set -euo pipefail
run="${1:?run dir}"; out="${2:?out dir}"
state="${run}/state.json"
[ -f "$state" ] || { echo "no state.json at $state" >&2; exit 1; }

mkdir -p "$out"

here="$(cd "$(dirname "$0")" && pwd)"
tpl="${here}/../templates/final.html.tpl"
[ -f "$tpl" ] || { echo "missing template: $tpl" >&2; exit 1; }

project="$(jq -r .project "$state")"
run_id="$(jq -r .run_id "$state")"
mode="$(jq -r .mode "$state")"
planned="$(jq -r .totals.planned "$state")"
pass="$(jq -r .totals.pass "$state")"
fail="$(jq -r .totals.fail "$state")"
skip="$(jq -r .totals.skip "$state")"
human_pending="$(jq -r '[.human_handoffs[]?|select(.status=="pending")]|length' "$state")"
p0_fails="$(jq -r '[.features[].cases[] | select(.status=="failed" and .severity=="P0")] | length' "$state")"

# 捏造PASS検出: status=passed なのに証拠 (screenshot/DB/network) が皆無の TC = 未証明PASS。
# 1 件でもあれば「この run は信頼できない」とみなし、判定を最優先でブロックする。
unproven="$(jq -r '[.features[].cases[]
  | select(.status=="passed")
  | select(((.evidence.screenshots // []) | length)==0
       and ((.evidence.db_checks // []) | length)==0
       and ((.evidence.network // "")==""))] | length' "$state")"

if   [ "$unproven" -gt 0 ]; then verdict_en="BLOCK"; verdict_ja="信頼不可（未証明PASSあり）"; cls="block"; emoji="🔴"
elif [ "$p0_fails" -gt 0 ]; then verdict_en="BLOCK"; verdict_ja="マージ不可"; cls="block"; emoji="🔴"
elif [ "$fail" -gt 0 ];     then verdict_en="WARNING"; verdict_ja="要注意"; cls="warn"; emoji="🟡"
elif [ "$skip" -gt 0 ] || [ "$human_pending" -gt 0 ]; then verdict_en="PARTIAL"; verdict_ja="一部スキップ"; cls="warn"; emoji="🟡"
else verdict_en="PASS"; verdict_ja="合格"; cls="pass"; emoji="🟢"; fi

if [ "$unproven" -gt 0 ]; then
  echo "[render] ⚠ 未証明PASS ${unproven} 件 — 証拠の無い passed は捏造とみなし判定をBLOCKにしました。" >&2
fi

# === HTML 生成 ===
# Python で安全に置換（sed/awk の特殊文字 [&, |, \, /] を含む可能性のある
# プロジェクト名・JSON ペイロードでも壊れないようにするため）
TPL_PATH="$tpl" STATE_PATH="$state" \
PROJECT="$project" RUN_ID="$run_id" MODE="$mode" \
VERDICT="$verdict_en" VERDICT_JA="$verdict_ja" VERDICT_CLASS="$cls" VERDICT_EMOJI="$emoji" \
PLANNED="$planned" PASS_N="$pass" FAIL_N="$fail" SKIP_N="$skip" HUMAN_PENDING="$human_pending" \
UNPROVEN="$unproven" \
python3 - <<'PYEOF' > "${out}/final.html"
import os, json
tpl = open(os.environ['TPL_PATH'], 'r', encoding='utf-8').read()
state_obj = json.load(open(os.environ['STATE_PATH'], 'r', encoding='utf-8'))
state_inline = json.dumps(state_obj, ensure_ascii=False, separators=(',', ':')).replace('</script', '<\\/script')
m = {
    '{{PROJECT}}': os.environ['PROJECT'],
    '{{RUN_ID}}': os.environ['RUN_ID'],
    '{{MODE}}': os.environ['MODE'],
    '{{VERDICT}}': os.environ['VERDICT'],
    '{{VERDICT_JA}}': os.environ['VERDICT_JA'],
    '{{VERDICT_CLASS}}': os.environ['VERDICT_CLASS'],
    '{{VERDICT_EMOJI}}': os.environ['VERDICT_EMOJI'],
    '{{PLANNED}}': os.environ['PLANNED'],
    '{{PASS}}': os.environ['PASS_N'],
    '{{FAIL}}': os.environ['FAIL_N'],
    '{{SKIP}}': os.environ['SKIP_N'],
    '{{HUMAN_PENDING}}': os.environ['HUMAN_PENDING'],
    '{{UNPROVEN}}': os.environ.get('UNPROVEN', '0'),
}
for k, v in m.items():
    tpl = tpl.replace(k, v)
# STATE_JSON は最後に置換（中身に他のプレースホルダ文字列があっても干渉しない）
tpl = tpl.replace('{{STATE_JSON}}', state_inline)
print(tpl, end='')
PYEOF

# === final.json（クラスタ集計込み）===
jq --arg verdict "$(echo "$verdict_en" | tr A-Z a-z)" --arg report_id "${run_id}-final" '
  . as $s
  | [.features[].cases[] | select(.status=="failed")] as $fails
  | ($fails | group_by(.root_cause_id // "_solo_" + .id)
    | map({
        cluster_id: (.[0].root_cause_id // "tc-" + .[0].id),
        members: map(.id),
        max_severity: (map(.severity) | min_by(if .=="P0" then 0 elif .=="P1" then 1 else 2 end)),
        common_summary: (map(.failure.summary // "") | unique | join(" / ")),
        common_workaround: (map(.failure.workaround // "") | map(select(. != "")) | unique | first),
        impacts: (map(.user_impact // "") | map(select(. != "")) | unique)
      })) as $clusters
  | {
      schema_version: "1.2",
      report_id: $report_id,
      run_id: .run_id,
      verdict: $verdict,
      totals: .totals,
      unproven_passes: [.features[].cases[]
        | select(.status=="passed")
        | select(((.evidence.screenshots // []) | length)==0
             and ((.evidence.db_checks // []) | length)==0
             and ((.evidence.network // "")==""))
        | {id, title, screen, severity}],
      blockers_P0: [.features[].cases[] | select(.status=="failed" and .severity=="P0") | {id, title, screen, user_impact, summary: (.failure.summary // "")}],
      high_fails_P1: [.features[].cases[] | select(.status=="failed" and .severity=="P1") | {id, title, screen}],
      clusters: $clusters,
      coverage_by_category: ([.features[].cases[]] | group_by(.category // "その他") | map({
        key: (.[0].category // "その他"),
        value: {
          planned: length,
          pass: map(select(.status=="passed"))|length,
          fail: map(select(.status=="failed"))|length,
          skip: map(select(.status=="skipped"))|length
        }
      }) | from_entries),
      per_feature: [.features[] | {id, name, totals, status}],
      human_handoffs_pending: ([.human_handoffs[]?|select(.status=="pending")]|length)
    }
' "$state" > "${out}/final.json"

# === final.md（narrative）===
{
  echo "# QA レポート — ${project}"
  echo
  echo "${emoji} **判定：${verdict_ja}**　／　${mode} モード　／　実行 ID \`${run_id}\`"
  echo
  echo "計画 ${planned}　／　🟢 合格 ${pass}　／　🔴 失敗 ${fail}　／　⏸ スキップ ${skip}　／　人間依頼 未対応 ${human_pending}"
  echo
  echo "---"
  echo

  # ===== 未証明PASS 警告（最優先で出す）=====
  if [ "$unproven" -gt 0 ]; then
    echo "## ⚠ 未証明PASS ${unproven} 件（信頼不可）"
    echo
    echo "以下は \`passed\` だが証拠（スクリーンショット / DB照会 / network）が 1 つも無い TC です。"
    echo "**証拠の無い PASS は「実際にテストしていない＝捏造」とみなし、合格として扱いません。**"
    echo "実機で再実行して証拠を残すか、\`planned\` に戻してください。"
    echo
    jq -r '.features[].cases[]
      | select(.status=="passed")
      | select(((.evidence.screenshots // []) | length)==0
           and ((.evidence.db_checks // []) | length)==0
           and ((.evidence.network // "")==""))
      | "- `" + .id + "` " + (.screen // "") + " ／ " + .title + "（" + .severity + "）"' "$state"
    echo
    echo "---"
    echo
  fi

  # ===== 結論（1 段落）=====
  echo "## 結論"
  echo
  if [ "$p0_fails" -gt 0 ]; then
    impacts=$(jq -r '[.features[].cases[] | select(.status=="failed" and .severity=="P0") | (.user_impact // .failure.summary // "")] | unique | map("「" + . + "」") | .[:2] | join("、")' "$state")
    echo "${p0_fails} 件の P0 失敗があり、現状では **マージ不可** です。"
    echo "主な実害は ${impacts}。詳細は「次の一手」セクションで原因クラスタごとに整理しています。"
  elif [ "$fail" -gt 0 ]; then
    echo "P0 失敗はありませんが、${fail} 件の P1/P2 失敗があります。"
    echo "リリース可否は失敗内容次第で、後述の「次の一手」を確認した上で判断してください。"
  else
    echo "全 ${pass} 件が合格しました。既知のリグレなし。"
  fi
  echo

  # ===== どこまで動いた / どこで止まった =====
  echo "## サマリ"
  echo
  echo "- **どこまで動いた:** $(jq -r '[.features[] | select(.totals.fail == 0 and .totals.pass > 0) | .name] | join("、")' "$state")"
  echo "- **どこで止まった:** $(jq -r '[.features[] | select(.totals.fail > 0) | "\(.name)（失敗 \(.totals.fail)）"] | join("、")' "$state")"
  if [ "$p0_fails" -gt 0 ]; then
    echo "- **リリースへの影響:** 上記 P0 を修正しない限りデプロイ不可"
    echo "- **次の一手:** 「次の一手」セクションの推奨修正を順に実施 → 該当 TC を再走"
  elif [ "$fail" -gt 0 ]; then
    echo "- **リリースへの影響:** 失敗内容により判断"
    echo "- **次の一手:** P1 失敗を確認し、ブロッカーでなければ Issue 化してマージ可"
  else
    echo "- **リリースへの影響:** なし"
    echo "- **次の一手:** マージしてデプロイ"
  fi
  echo

  # ===== 次の一手（クラスタ別）=====
  if [ "$fail" -gt 0 ]; then
    echo "## 次の一手（根本原因クラスタ）"
    echo
    echo "失敗 ${fail} 件を **根本原因** で束ねたものです。同じクラスタは 1 つの修正でまとめて直せます。"
    echo
    jq -r '
      [.features[].cases[] | select(.status=="failed")]
      | group_by(.root_cause_id // ("_solo_" + .id))
      | map({
          members: .,
          max_sev: (map(.severity) | min_by(if .=="P0" then 0 elif .=="P1" then 1 else 2 end))
        })
      | sort_by(if .max_sev=="P0" then 0 elif .max_sev=="P1" then 1 else 2 end)
      | to_entries
      | map(
          ([.value.members[0].root_cause_id // .value.members[0].title] | .[0]) as $title
          | "\n### " + ([65 + .key] | implode) + ". " + $title + "（" + (.value.members | length | tostring) + " 件 / 最高 " + .value.max_sev + "）\n"
            + "- **該当:** " + (.value.members | map(.id) | join(", ")) + "\n"
            + "- **症状:** " + ((.value.members | map(.failure.summary // "") | map(select(. != "")) | unique)[0] // "—") + "\n"
            + (if (.value.members | map(.user_impact // "") | map(select(. != "")) | unique) | length > 0
               then "- **実害:** " + (.value.members | map(.user_impact // "") | map(select(. != "")) | unique | join(" / ")) + "\n"
               else "" end)
            + "- **原因仮説:** " + ((.value.members | map(.failure.hypothesis // "") | map(select(. != "")) | unique)[0] // "—") + "\n"
            + "- **推奨修正:** " + ((.value.members | map(.failure.workaround // "") | map(select(. != "")) | unique)[0] // "—")
        )
      | .[]
    ' "$state"
    echo
  fi

  # ===== 守れていた振る舞い =====
  if [ "$pass" -gt 0 ]; then
    echo "## 守れていた振る舞い"
    echo
    regs=$(jq -r '[.features[].cases[] | select(.status=="passed") | (.notes // "") | scan("\\b[A-Z]\\d+\\b")] | unique | join(", ")' "$state" 2>/dev/null || echo "")
    if [ -n "$regs" ] && [ "$regs" != "" ]; then
      echo "- **既知バグの再発防止（リグレ確認）:** ${regs}"
    fi
    fully_passed=$(jq -r '[.features[] | select(.totals.fail == 0 and .totals.pass > 0) | "\(.name)（\(.totals.pass) 件）"] | join("、")' "$state")
    if [ -n "$fully_passed" ]; then
      echo "- **機能まるごと合格:** ${fully_passed}"
    fi
    echo
  fi

  # ===== 個別失敗詳細 =====
  if [ "$fail" -gt 0 ]; then
    echo "## 個別失敗詳細"
    echo
    jq -r '.features[].cases[] | select(.status=="failed")
      | "### " + .id + "　" + (.screen // "") + " ／ " + .title + "（" + .severity + "）\n"
        + (if .failure.summary then "- **要約:** " + .failure.summary + "\n" else "" end)
        + (if .user_impact then "- **実害:** " + .user_impact + "\n" else "" end)
        + (if .failure.expected then "- **期待:** " + .failure.expected + "\n" else "" end)
        + (if .failure.actual then "- **実際:** " + .failure.actual + "\n" else "" end)
        + (if .failure.hypothesis then "- **原因仮説:** " + .failure.hypothesis + "\n" else "" end)
        + (if .failure.workaround then "- **回避策:** " + .failure.workaround + "\n" else "" end)
        + (if (.failure.repro_steps // []) | length > 0
           then "- **再現手順:**\n" + (.failure.repro_steps | to_entries | map("    \(.key+1). \(.value)") | join("\n"))
           else "" end)
      ' "$state"
    echo
  fi

  # ===== 人間依頼 =====
  echo "## 人間依頼"
  echo
  ho_count=$(jq -r '[.human_handoffs[]?] | length' "$state")
  if [ "$ho_count" -gt 0 ]; then
    jq -r '.human_handoffs[]? | "- [" + (.status|sub("pending";"未対応")|sub("requested";"依頼済")|sub("answered";"回答済")|sub("skipped";"スキップ")) + "] **" + .id + "** " + .title + (if .result then "（" + .result + "）" else "" end)' "$state"
  else
    echo "- なし"
  fi
  echo

  # ===== 添付 =====
  echo "## 添付"
  echo
  echo "- 人間用ダッシュボード: \`final.html\`（ブラウザで開く / 印刷対応）"
  echo "- 機械用 JSON: \`final.json\`（クラスタ集計込み）"
  echo "- 実行ログ正本: \`runs/${run_id}/state.json\`"
} > "${out}/final.md"

echo "生成完了: ${out}/final.html, ${out}/final.json, ${out}/final.md"
echo "判定: ${verdict_ja}（P0 失敗 ${p0_fails} / 全失敗 ${fail}）"
