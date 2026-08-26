#!/usr/bin/env bash
# render_matrix.sh — state.json から検証マトリクス(CSV)を生成する。
# 画面検証は「1画面=1CSV(=1ワークシート)」で 9列固定(ID/画面/テスト観点/テスト項目/前提条件/
# 操作手順/期待結果/結果/備考)。加えて軸別タブ(summary/routes/rls-matrix/zero-state/agent-behavior/
# journeys)を出力。任意のスプレッドシートにインポート可能。詳細 references/spreadsheet-matrix.md。
#
# 使い方: scripts/render_matrix.sh <run-dir> [out-dir]
set -euo pipefail
RUN_DIR="${1:?usage: render_matrix.sh <run-dir> [out-dir]}"
OUT_DIR="${2:-$RUN_DIR}"
STATE="$RUN_DIR/state.json"
[ -f "$STATE" ] || { echo "state.json not found: $STATE" >&2; exit 1; }
mkdir -p "$OUT_DIR/matrix"

node - "$STATE" "$OUT_DIR/matrix" <<'NODE'
const fs = require('fs');
const [statePath, outDir] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const tcs = state.tests || state.cases || state.tcs || state.results ||
  (Array.isArray(state.features) ? state.features.flatMap(f => f.tests || f.cases || []) : []) || [];

const cell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
const write = (name, headers, rows) => {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map(h => cell(r[h])).join(','));
  fs.writeFileSync(`${outDir}/${name}.csv`, '﻿' + lines.join('\n') + '\n');
  console.log(`  ${name}.csv: ${rows.length} 行`);
};
// status → 結果(完了/未着手/FAIL)
const kekka = (s) => ({ passed:'完了', failed:'FAIL', planned:'未着手', blocked:'FAIL', skipped:'スキップ' }[s] || (s||'未着手'));
const sanitize = (s) => String(s||'screen').replace(/[\/\\:*?"<>|]/g,'_').slice(0,60);
const tabOf = (t) => t.tab || t.axis || (/(route|api)/i.test(t.category||'') ? 'routes'
  : /rls|tenant|role/i.test(t.category||'') ? 'rls-matrix'
  : /zero|seed|bootstrap/i.test(t.category||'') ? 'zero-state'
  : /agent|chat|tool|llm/i.test(t.category||'') ? 'agent-behavior'
  : /journey|flow/i.test(t.category||'') ? 'journeys' : 'screens');
const evi = (t) => (t.evidence && (t.evidence.screenshots?.[0]||t.evidence.db_checks?.[0]||t.evidence.network?.[0])) || t.evidence_path || '';

const byTab = {};
for (const t of tcs) (byTab[tabOf(t)] ??= []).push(t);

// 画面タブ: 1画面=1CSV。タブ名(画面名)は state.json の画面から動的導出(固定リストにしない)。
// 列は推奨デフォルト(画面名はタブ名に持つので列からは除き、証拠列を独立させる)。
const SCREEN_COLS = ['ID','テスト観点','テスト項目','前提条件','操作手順','期待結果','結果','証拠','備考'];
const screenRows = byTab['screens'] || [];
const byScreen = {};
for (const t of screenRows) (byScreen[t.screen || t.screen_id || t.screenId || 'screen'] ??= []).push(t);
const screenIndex = [];
let si = 0;
for (const [screen, list] of Object.entries(byScreen)) {
  si++;
  let i = 0;
  const rows = list.map(t => ({
    ID: t.row_id ?? ++i, テスト観点: t.aspect||t.観点||t.category||'',
    テスト項目: t.item||t.title||t.テスト項目||'', 前提条件: t.precondition||t.前提条件||'-',
    操作手順: t.steps||t.手順||'', 期待結果: t.expected||t.期待||'',
    結果: kekka(t.status), 証拠: evi(t), 備考: t.note||t.備考||'',
  }));
  const fname = `screen-${String(si).padStart(2,'0')}-${sanitize(screen)}`;
  write(fname, SCREEN_COLS, rows);
  const done = list.filter(t=>t.status==='passed').length;
  screenIndex.push({ tab: screen, total: list.length, 完了: done, FAIL: list.filter(t=>t.status==='failed'||t.status==='blocked').length,
    未着手: list.filter(t=>t.status==='planned'||!t.status).length, 検証率: list.length?Math.round(done/list.length*100)+'%':'0%' });
}

// 軸別タブ(結果列付き)
const AXIS = {
  routes: ['method','path','db_op','schema_ok','http','systemic_class','結果','備考'],
  'rls-matrix': ['table','role','op','期待','実測','cross_tenant','結果'],
  'zero-state': ['step','期待','実測','結果','備考'],
  'agent-behavior': ['scenario_id','意図','expected_tool','expected_side_effect','tool_calls','db_diff','結果'],
  journeys: ['journey','step','操作','期待','結果','備考'],
};
const pick = (t,c)=> c==='結果'?kekka(t.status): (t[c] ?? ({期待:t.expected,実測:t.actual,意図:t.intent,操作:t.action,備考:(t.note||evi(t))}[c]) ?? '');
const axisSummary = [];
for (const [tab,cols] of Object.entries(AXIS)) {
  const list = byTab[tab]||[]; if (!list.length) continue;
  write(tab, cols, list.map(t=>Object.fromEntries(cols.map(c=>[c,pick(t,c)]))));
  const done=list.filter(t=>t.status==='passed').length;
  axisSummary.push({ tab, total:list.length, 完了:done, FAIL:list.filter(t=>t.status==='failed'||t.status==='blocked').length,
    未着手:list.filter(t=>t.status==='planned'||!t.status).length, 検証率:list.length?Math.round(done/list.length*100)+'%':'0%' });
}

// summary(画面タブ + 軸タブ)
write('summary', ['tab','total','完了','FAIL','未着手','検証率'], [...screenIndex, ...axisSummary]);
console.log('matrix 生成完了 →', outDir, `(画面タブ ${si} / 軸タブ ${axisSummary.length})`);
NODE
