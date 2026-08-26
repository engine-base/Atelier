<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>QA レポート — {{PROJECT}} / {{RUN_ID}}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --bg: #fbfaf8;
    --paper: #ffffff;
    --panel-2: #f5f3ee;
    --line: #e3ddd0;
    --line-soft: #efeae0;
    --text: #1a1a1a;
    --muted: #75705f;
    --green: #2e7d32;
    --green-bg: #e8f5e9;
    --green-line: #a3cca5;
    --yellow: #b6730d;
    --yellow-bg: #fff4e0;
    --yellow-line: #e8c98a;
    --red: #b8331f;
    --red-bg: #fdecea;
    --red-line: #e89a8e;
    --blue: #1565c0;
    --blue-bg: #e3f0fb;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body {
    margin: 0;
    font: 14px/1.7 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic Medium", "Meiryo", "Segoe UI", sans-serif;
    color: var(--text);
  }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ===== Verdict banner ===== */
  .verdict-banner {
    padding: 24px 32px;
    background: var(--paper);
    border-bottom: 1px solid var(--line);
    position: sticky; top: 0; z-index: 10;
    box-shadow: 0 1px 0 rgba(0,0,0,.02);
  }
  .verdict-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .verdict-badge {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 16px; border-radius: 10px;
    font-weight: 700; font-size: 14px;
  }
  .verdict-badge.block { background: var(--red); color: #fff; }
  .verdict-badge.warn { background: var(--yellow); color: #fff; }
  .verdict-badge.pass { background: var(--green); color: #fff; }
  .verdict-meta { color: var(--muted); font-size: 13px; }
  .verdict-meta strong { color: var(--text); }
  .verdict-headline { margin-top: 8px; font-size: 14px; line-height: 1.6; }
  .verdict-headline strong { color: var(--red); }

  /* ===== Main ===== */
  main { padding: 28px 32px 80px; max-width: 1100px; margin: 0 auto; }
  h2 {
    font-size: 13px; color: var(--muted); margin: 36px 0 12px;
    font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  }
  h2:first-of-type { margin-top: 4px; }
  h3 { font-size: 15px; margin: 0 0 8px; font-weight: 700; }

  /* ===== Cards ===== */
  .stats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
  .stat {
    background: var(--paper); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px 16px;
  }
  .stat .n { font-size: 28px; font-weight: 700; line-height: 1; }
  .stat .l { color: var(--muted); font-size: 11px; margin-top: 6px; }
  .stat.pass { background: var(--green-bg); border-color: var(--green-line); }
  .stat.fail { background: var(--red-bg); border-color: var(--red-line); }
  .stat.warn { background: var(--yellow-bg); border-color: var(--yellow-line); }
  .stat.pass .n { color: var(--green); }
  .stat.fail .n { color: var(--red); }
  .stat.warn .n { color: var(--yellow); }

  /* ===== Executive summary ===== */
  .exec {
    background: var(--paper); border: 1px solid var(--line); border-radius: 12px;
    padding: 20px 24px; margin: 8px 0 0;
  }
  .exec p { margin: 0 0 10px; }
  .exec .label {
    display: inline-block; min-width: 110px; color: var(--muted); font-weight: 600; font-size: 12px;
  }

  /* ===== Cluster cards ===== */
  .clusters { display: grid; gap: 14px; }
  .cluster {
    background: var(--paper); border: 1px solid var(--line); border-left: 4px solid var(--red);
    border-radius: 10px; padding: 18px 22px;
  }
  .cluster.sev-P0 { border-left-color: var(--red); }
  .cluster.sev-P1 { border-left-color: var(--yellow); }
  .cluster.sev-P2 { border-left-color: var(--muted); }
  .cluster-header {
    display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    margin-bottom: 10px;
  }
  .cluster-letter {
    background: var(--red); color: #fff; font-weight: 700;
    width: 28px; height: 28px; border-radius: 50%;
    display: inline-flex; align-items: center; justify-content: center; font-size: 13px;
  }
  .cluster.sev-P1 .cluster-letter { background: var(--yellow); }
  .cluster.sev-P2 .cluster-letter { background: var(--muted); }
  .cluster-title { font-size: 16px; font-weight: 700; flex: 1; }
  .cluster-meta { color: var(--muted); font-size: 12px; }
  .cluster-grid {
    display: grid; gap: 8px 16px;
    grid-template-columns: 90px 1fr;
    margin: 8px 0;
  }
  .cluster-grid dt { color: var(--muted); font-size: 12px; font-weight: 600; }
  .cluster-grid dd { margin: 0; font-size: 13px; }
  .cluster-tcs {
    display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px;
  }
  .cluster-tcs a {
    font-family: ui-monospace, Menlo, monospace; font-size: 11px;
    background: var(--red-bg); color: var(--red);
    padding: 2px 8px; border-radius: 4px; font-weight: 600;
  }
  .cluster.sev-P1 .cluster-tcs a { background: var(--yellow-bg); color: var(--yellow); }

  /* ===== Coverage bar chart ===== */
  .cov-table {
    background: var(--paper); border: 1px solid var(--line); border-radius: 10px;
    padding: 12px 16px;
  }
  .cov-row {
    display: grid; grid-template-columns: 130px 1fr 80px;
    align-items: center; gap: 12px;
    padding: 8px 0; border-top: 1px solid var(--line-soft);
  }
  .cov-row:first-child { border-top: 0; }
  .cov-label { font-size: 13px; font-weight: 600; }
  .cov-bar {
    height: 14px; border-radius: 7px; background: var(--panel-2); position: relative; overflow: hidden;
  }
  .cov-bar-pass { background: var(--green); height: 100%; }
  .cov-bar-fail { background: var(--red); height: 100%; }
  .cov-bar-skip { background: var(--yellow); height: 100%; }
  .cov-bar-stack { display: flex; height: 100%; }
  .cov-count { font-size: 12px; color: var(--muted); text-align: right; }

  /* ===== Detail tables ===== */
  details.feature {
    background: var(--paper); border: 1px solid var(--line); border-radius: 10px;
    padding: 0 18px; margin: 8px 0;
  }
  details.feature.has-fail { border-color: var(--red-line); }
  details.feature > summary {
    cursor: pointer; font-weight: 600; padding: 14px 0; list-style: none;
    display: flex; align-items: center; gap: 12px;
  }
  details.feature > summary::-webkit-details-marker { display: none; }
  details.feature > summary::before {
    content: "▸"; color: var(--muted); font-size: 12px;
  }
  details.feature[open] > summary::before { content: "▾"; }
  .feature-counts {
    margin-left: auto; font-size: 12px; color: var(--muted);
  }
  .feature-counts .ok { color: var(--green); }
  .feature-counts .ng { color: var(--red); }

  table {
    width: 100%; border-collapse: collapse;
    margin: 4px 0 12px;
  }
  th, td {
    padding: 10px 12px; border-bottom: 1px solid var(--line-soft);
    text-align: left; vertical-align: top; font-size: 13px;
  }
  th { background: var(--panel-2); font-weight: 600; color: var(--muted); font-size: 11px;
       text-transform: uppercase; letter-spacing: .04em; }
  td.id { font-family: ui-monospace, Menlo, monospace; font-weight: 600; font-size: 12px; }
  tr:last-child td { border-bottom: 0; }
  tr.row-failed { background: var(--red-bg); }
  tr.row-failed td { color: var(--text); }
  tr.row-unproven { background: repeating-linear-gradient(45deg, var(--red-bg), var(--red-bg) 10px, #fff5f3 10px, #fff5f3 20px); }

  .pill {
    display: inline-block; padding: 2px 10px; border-radius: 999px;
    font-size: 11px; font-weight: 700;
  }
  .p-passed { background: var(--green-bg); color: var(--green); }
  .p-failed { background: var(--red-bg); color: var(--red); }
  .p-skipped { background: #ececec; color: var(--muted); }
  .p-flaky { background: var(--yellow-bg); color: var(--yellow); }
  .p-planned { background: #eaeaea; color: var(--muted); }

  .sev {
    display: inline-block; padding: 1px 7px; border-radius: 4px;
    font-size: 10px; font-weight: 700; color: #fff;
  }
  .sev-P0 { background: var(--red); }
  .sev-P1 { background: var(--yellow); }
  .sev-P2 { background: var(--muted); }

  .failure-detail {
    background: var(--red-bg); border-left: 3px solid var(--red);
    padding: 12px 16px; margin: 0 0 8px; border-radius: 0 6px 6px 0;
    font-size: 13px;
  }
  .failure-detail dl { display: grid; grid-template-columns: 80px 1fr; gap: 4px 12px; margin: 0; }
  .failure-detail dt { color: var(--red); font-weight: 700; font-size: 11px; padding-top: 2px; }
  .failure-detail dd { margin: 0; }
  .failure-detail ol { margin: 4px 0 0; padding-left: 22px; }

  /* ===== Filter ===== */
  .filter { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 16px; }
  .filter button {
    background: var(--paper); border: 1px solid var(--line); color: var(--text);
    padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 600;
  }
  .filter button.active { background: var(--blue); border-color: var(--blue); color: #fff; }

  /* ===== Search ===== */
  .search-row { margin: 0 0 12px; }
  .search-row input {
    width: 100%; padding: 10px 14px;
    border: 1px solid var(--line); border-radius: 8px;
    font-size: 13px; background: var(--paper); color: var(--text);
  }

  /* ===== Card grid for handoffs / assumptions ===== */
  .mini-cards { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .mini-card {
    background: var(--paper); border: 1px solid var(--line); border-radius: 8px;
    padding: 12px 14px; font-size: 13px;
  }
  .mini-card .mc-id { font-family: ui-monospace, Menlo, monospace; color: var(--muted); font-size: 11px; }

  /* ===== Anchor ===== */
  .anchor {
    color: var(--muted); opacity: 0; transition: opacity .1s;
    margin-left: 6px; text-decoration: none; font-size: 11px;
  }
  tr:hover .anchor, .cluster-header:hover .anchor { opacity: 1; }

  /* ===== Print ===== */
  @media print {
    .filter, .search-row, .anchor { display: none; }
    .verdict-banner { position: static; box-shadow: none; }
    details { page-break-inside: avoid; }
    details > summary::before { display: none; }
    details:not([open]) > summary + * { display: block !important; }
    details:not([open])[data-force-open] {}
    .cluster { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<!-- ====================================================== -->
<!-- 1. 判定バナー（1 行で結論）                              -->
<!-- ====================================================== -->
<div class="verdict-banner">
  <div class="verdict-row">
    <span class="verdict-badge {{VERDICT_CLASS}}">{{VERDICT_EMOJI}} 判定：{{VERDICT_JA}}</span>
    <span class="verdict-meta"><strong>{{PROJECT}}</strong></span>
    <span class="verdict-meta">モード: <strong>{{MODE}}</strong></span>
    <span class="verdict-meta">実行 ID: <code>{{RUN_ID}}</code></span>
    <span class="verdict-meta" style="margin-left:auto">計画 <strong>{{PLANNED}}</strong> ／ 合格 <strong style="color:var(--green)">{{PASS}}</strong> ／ 失敗 <strong style="color:var(--red)">{{FAIL}}</strong></span>
  </div>
  <div class="verdict-headline" id="verdict-headline"></div>
</div>

<main>

  <!-- ====================================================== -->
  <!-- 0. 未証明PASS 警告（証拠の無い passed = 捏造とみなす）   -->
  <!-- ====================================================== -->
  <div id="unproven-banner" style="display:none; background:var(--red-bg); border:1px solid var(--red-line); border-left:4px solid var(--red); border-radius:10px; padding:14px 18px; margin:4px 0 20px;">
    <div style="font-weight:700; color:var(--red); margin-bottom:6px;">⚠ 未証明PASS <span id="unproven-count">0</span> 件 — この結果は信頼できません</div>
    <div style="font-size:13px; color:var(--text);">証拠（スクリーンショット / DB照会 / network）の無い <code>passed</code> は「実際にテストしていない＝捏造」とみなします。下表で <strong style="color:var(--red)">⚠未証明</strong> の TC を再実行して証拠を残すか、未実施に戻してください。</div>
    <div id="unproven-list" style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;"></div>
  </div>

  <!-- ====================================================== -->
  <!-- 2. エグゼクティブサマリ                                  -->
  <!-- ====================================================== -->
  <h2>結論とサマリ</h2>
  <div class="exec" id="exec"></div>

  <!-- ====================================================== -->
  <!-- 3. 次の一手（根本原因クラスタ）                          -->
  <!-- ====================================================== -->
  <h2>次の一手（根本原因クラスタ）</h2>
  <div class="clusters" id="clusters"></div>

  <!-- ====================================================== -->
  <!-- 4. 観点別カバレッジ（バー）                              -->
  <!-- ====================================================== -->
  <h2>観点別カバレッジ</h2>
  <div class="cov-table" id="coverage"></div>

  <!-- ====================================================== -->
  <!-- 5. 守れていた振る舞い（合格ハイライト）                  -->
  <!-- ====================================================== -->
  <h2>守れていた振る舞い</h2>
  <div class="exec" id="kept"></div>

  <!-- ====================================================== -->
  <!-- 6. 全テスト 横断一覧（常時表示・1 行 1 TC）              -->
  <!-- ====================================================== -->
  <h2>全テスト一覧（横断）</h2>
  <div class="search-row">
    <input id="q" placeholder="🔍 ID / テスト項目 / 観点 / 画面 / 機能 で検索" />
  </div>
  <div class="filter">
    <button data-f="all" class="active">すべて表示</button>
    <button data-f="failed">失敗のみ</button>
    <button data-f="P0">P0 のみ</button>
    <button data-f="passed">合格のみ</button>
  </div>
  <div class="cov-table" id="all-tests-wrap">
    <table id="all-tests">
      <thead>
        <tr>
          <th style="width:90px">ID</th>
          <th style="width:120px">機能</th>
          <th style="width:90px">観点</th>
          <th>テスト項目</th>
          <th style="width:60px">重要度</th>
          <th style="width:80px">結果</th>
          <th style="width:90px">証拠</th>
        </tr>
      </thead>
      <tbody id="all-tests-body"></tbody>
    </table>
  </div>

  <!-- ====================================================== -->
  <!-- 6.5 テスト仕様書ビュー（画面別シート / 9 列）            -->
  <!-- ====================================================== -->
  <style>
    .sheet-tabs { display:flex; flex-wrap:wrap; gap:4px; margin:8px 0 0; }
    .sheet-tab { border:1px solid var(--line); background:var(--panel-2); color:var(--muted);
      padding:6px 12px; border-radius:8px 8px 0 0; font-size:12px; cursor:pointer; }
    .sheet-tab.active { background:var(--paper); color:var(--text); font-weight:700; border-bottom-color:var(--paper); }
    table.sheet-table { width:100%; border-collapse:collapse; background:var(--paper);
      border:1px solid var(--line); font-size:12.5px; }
    table.sheet-table th, table.sheet-table td { border:1px solid var(--line-soft);
      padding:6px 8px; text-align:left; vertical-align:top; }
    table.sheet-table thead th { background:var(--panel-2); position:sticky; top:0; font-weight:700; }
    table.sheet-table td { white-space:pre-wrap; }
    .qa-pill { display:inline-block; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; }
    .qa-pill.passed { background:var(--green-bg); color:var(--green); }
    .qa-pill.failed { background:var(--red-bg); color:var(--red); }
    .qa-pill.skipped, .qa-pill.blocked { background:var(--panel-2); color:var(--muted); }
    .qa-pill.flaky { background:var(--yellow-bg); color:var(--yellow); }
    .qa-pill.planned, .qa-pill.running { background:var(--blue-bg); color:var(--blue); }
  </style>
  <h2>テスト仕様書ビュー（画面別）</h2>
  <div id="sheet-tabs" class="sheet-tabs"></div>
  <div style="overflow:auto; max-height:70vh; border:1px solid var(--line)">
    <table class="sheet-table" id="sheet-table">
      <thead><tr>
        <th style="width:56px">ID</th><th style="width:104px">画面</th><th style="width:104px">テスト観点</th>
        <th>テスト項目</th><th style="width:150px">前提条件</th><th>操作手順</th><th>期待結果</th>
        <th style="width:70px">結果</th><th style="width:120px">備考</th>
      </tr></thead>
      <tbody id="sheet-body"></tbody>
    </table>
  </div>

  <!-- ====================================================== -->
  <!-- 7. 機能別 詳細（失敗の再現手順込み・折りたたみ）          -->
  <!-- ====================================================== -->
  <h2>機能別 詳細（手順・期待結果・再現手順）</h2>
  <div id="features"></div>

  <!-- ====================================================== -->
  <!-- 7. 人間依頼 / 前提                                       -->
  <!-- ====================================================== -->
  <h2>人間依頼</h2>
  <div class="mini-cards" id="handoffs"></div>

  <h2>前提条件（Assumptions）</h2>
  <div class="mini-cards" id="assumptions"></div>

  <p class="verdict-meta" style="margin-top:48px;text-align:center">
    生成: human-grade-qa skill ／ 正本: <code>state.json</code> ／ 機械可読: <code>final.json</code>
  </p>
</main>

<script type="application/json" id="state">{{STATE_JSON}}</script>
<script>
  const state = JSON.parse(document.getElementById('state').textContent);
  const $ = (s, r=document) => r.querySelector(s);
  const el = (tag, props={}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    for (const k of kids) {
      if (k == null) continue;
      e.append(k?.nodeType ? k : document.createTextNode(String(k)));
    }
    return e;
  };

  const CATS = ["正常","異常","バリデーション","境界","権限","復帰","リグレ","セキュリティ","性能","整合性"];
  const STATUS_JA = {
    passed: "合格", failed: "失敗", skipped: "スキップ",
    blocked: "ブロック", flaky: "不安定", running: "実行中", planned: "未実施"
  };
  const SEV_RANK = { P0: 0, P1: 1, P2: 2 };

  const allCases = state.features.flatMap(f => f.cases.map(c => ({...c, feature: f.id, featureName: f.name})));
  const failed = allCases.filter(c => c.status === 'failed');
  const passed = allCases.filter(c => c.status === 'passed');

  // 証拠の有無: screenshot / DB照会 / network のいずれか実体があるか。
  const evidenceCount = (c) =>
    ((c.evidence?.screenshots || []).length) +
    ((c.evidence?.db_checks || []).length) +
    ((c.evidence?.network ? 1 : 0));
  const hasEvidence = (c) => evidenceCount(c) > 0;
  // 未証明PASS = passed なのに証拠ゼロ（＝捏造とみなす）。
  const unproven = passed.filter(c => !hasEvidence(c));

  // ===== 0. 未証明PASS バナー =====
  if (unproven.length) {
    const banner = document.getElementById('unproven-banner');
    banner.style.display = '';
    document.getElementById('unproven-count').textContent = unproven.length;
    const list = document.getElementById('unproven-list');
    for (const u of unproven) {
      list.append(el('a', {
        href: '#' + u.id,
        style: 'font-family:ui-monospace,Menlo,monospace;font-size:11px;background:#fff;color:var(--red);padding:2px 8px;border-radius:4px;font-weight:600;border:1px solid var(--red-line)'
      }, u.id));
    }
  }

  // ===== 1. Verdict headline =====
  const p0Fails = failed.filter(c => c.severity === 'P0');
  const hl = document.getElementById('verdict-headline');
  if (p0Fails.length) {
    const impacts = [...new Set(p0Fails.map(c => c.user_impact || c.failure?.summary).filter(Boolean))].slice(0, 2);
    hl.innerHTML = `<strong>${p0Fails.length} 件の P0 失敗</strong>あり。${impacts.map(i=>`「${i}」`).join('、')}${impacts.length ? '。' : ''}マージ前に修正が必要です。`;
  } else if (failed.length) {
    hl.innerHTML = `${failed.length} 件の失敗あり（全て P1 以下）。リリース可否は内容次第。`;
  } else {
    hl.innerHTML = `全 ${state.totals.pass} 件合格。リグレなし。`;
  }

  // ===== 2. Stats + Executive summary =====
  const exec = document.getElementById('exec');
  exec.innerHTML = `
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><div class="n">${state.totals.planned}</div><div class="l">計画 TC 数</div></div>
      <div class="stat pass"><div class="n">${state.totals.pass}</div><div class="l">合格</div></div>
      <div class="stat fail"><div class="n">${state.totals.fail}</div><div class="l">失敗</div></div>
      <div class="stat warn"><div class="n">${state.totals.skip}</div><div class="l">スキップ</div></div>
      <div class="stat"><div class="n">${(state.human_handoffs||[]).filter(h=>h.status==='pending').length}</div><div class="l">人間依頼（未対応）</div></div>
    </div>
  `;

  // どこまで動いた / どこで止まった
  const passedFeatures = state.features.filter(f => f.totals.fail === 0 && f.totals.pass > 0);
  const brokenFeatures = state.features.filter(f => f.totals.fail > 0);
  const passSummary = passedFeatures.map(f => f.name).join('、');
  const breakSummary = brokenFeatures.map(f => `${f.name}（失敗 ${f.totals.fail}）`).join('、');
  const next = p0Fails.length
    ? '下の「次の一手」3-5 クラスタを順に直して再走'
    : (failed.length ? 'P1 以下の失敗を確認してマージ可否を判断' : 'マージ可');

  const sumWrap = el('div');
  const rows = [
    { l: '結論', v: hl.textContent },
    { l: 'どこまで動いた', v: passSummary || '（合格機能なし）' },
    { l: 'どこで止まった', v: breakSummary || '（失敗なし）' },
    { l: '次の一手', v: next },
  ];
  for (const r of rows) {
    const p = el('p');
    p.append(el('span', { className: 'label' }, r.l + '：'));
    p.append(document.createTextNode(r.v));
    sumWrap.append(p);
  }
  exec.append(sumWrap);

  // ===== 3. Root-cause clusters =====
  const clustersRoot = document.getElementById('clusters');
  const groups = {};
  const ungrouped = [];
  for (const f of failed) {
    const key = f.root_cause_id;
    if (key) {
      groups[key] = groups[key] || { id: key, members: [], maxSev: 'P2' };
      groups[key].members.push(f);
      if (SEV_RANK[f.severity] < SEV_RANK[groups[key].maxSev]) groups[key].maxSev = f.severity;
    } else {
      ungrouped.push(f);
    }
  }
  const orderedClusters = Object.values(groups).sort((a,b) => SEV_RANK[a.maxSev] - SEV_RANK[b.maxSev]);
  // ungrouped each as its own "cluster"
  for (const u of ungrouped) {
    orderedClusters.push({ id: 'tc-' + u.id, members: [u], maxSev: u.severity, _solo: true });
  }

  const letterFor = (i) => String.fromCharCode(65 + i);

  if (!orderedClusters.length) {
    clustersRoot.innerHTML = '<div class="exec" style="text-align:center;color:var(--green);font-weight:600">失敗なし。次の一手は不要です。</div>';
  } else {
    orderedClusters.forEach((cl, i) => {
      const div = el('div', { className: 'cluster sev-' + cl.maxSev, id: 'cluster-' + cl.id });
      const header = el('div', { className: 'cluster-header' });
      header.append(el('span', { className: 'cluster-letter' }, letterFor(i)));
      // タイトル: cluster id か単独 TC のタイトル
      const title = cl._solo
        ? cl.members[0].title
        : (cl.id.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()));
      header.append(el('div', { className: 'cluster-title' }, title));
      header.append(el('span', { className: 'cluster-meta' }, `${cl.members.length} 件 / 最高 ${cl.maxSev}`));
      div.append(header);

      // 内容
      const dl = el('dl', { className: 'cluster-grid' });
      // 共通症状
      const summaries = [...new Set(cl.members.map(m => m.failure?.summary).filter(Boolean))];
      if (summaries.length) {
        dl.append(el('dt', {}, '症状'));
        const dd = el('dd');
        dd.append(summaries[0]);
        if (summaries.length > 1) dd.append(el('span', { className: 'cluster-meta', style: 'margin-left:8px' }, `+${summaries.length - 1} 件の類似`));
        dl.append(dd);
      }
      // 実害
      const impacts = [...new Set(cl.members.map(m => m.user_impact).filter(Boolean))];
      if (impacts.length) {
        dl.append(el('dt', {}, '実害'));
        dl.append(el('dd', {}, impacts.join(' / ')));
      }
      // 推奨修正（仮説の集約）
      const hypos = [...new Set(cl.members.map(m => m.failure?.hypothesis).filter(Boolean))];
      if (hypos.length) {
        dl.append(el('dt', {}, '原因仮説'));
        dl.append(el('dd', {}, hypos[0]));
      }
      const works = [...new Set(cl.members.map(m => m.failure?.workaround).filter(Boolean))];
      if (works.length) {
        dl.append(el('dt', {}, '推奨修正'));
        dl.append(el('dd', {}, works[0]));
      }
      div.append(dl);

      // TC リスト
      const tcs = el('div', { className: 'cluster-tcs' });
      for (const m of cl.members) {
        const a = el('a', { href: '#' + m.id }, m.id);
        tcs.append(a);
      }
      div.append(tcs);
      clustersRoot.append(div);
    });
  }

  // ===== 4. Coverage bars =====
  const cov = document.getElementById('coverage');
  const catData = {};
  for (const c of allCases) {
    const k = c.category || 'その他';
    catData[k] = catData[k] || { planned: 0, pass: 0, fail: 0, skip: 0 };
    catData[k].planned++;
    if (c.status === 'passed') catData[k].pass++;
    else if (c.status === 'failed') catData[k].fail++;
    else if (c.status === 'skipped') catData[k].skip++;
  }
  const catOrder = CATS.filter(c => catData[c]).concat(Object.keys(catData).filter(c => !CATS.includes(c)));
  for (const c of catOrder) {
    const d = catData[c];
    const row = el('div', { className: 'cov-row' });
    row.append(el('div', { className: 'cov-label' }, c));
    const barWrap = el('div', { className: 'cov-bar' });
    const stack = el('div', { className: 'cov-bar-stack' });
    if (d.pass) stack.append(el('div', { className: 'cov-bar-pass', style: `width:${(d.pass/d.planned*100)}%` }));
    if (d.fail) stack.append(el('div', { className: 'cov-bar-fail', style: `width:${(d.fail/d.planned*100)}%` }));
    if (d.skip) stack.append(el('div', { className: 'cov-bar-skip', style: `width:${(d.skip/d.planned*100)}%` }));
    barWrap.append(stack);
    row.append(barWrap);
    const cnt = el('div', { className: 'cov-count' }, `${d.pass} / ${d.planned}` + (d.fail ? ` (失敗 ${d.fail})` : ''));
    if (d.fail) cnt.style.color = 'var(--red)';
    row.append(cnt);
    cov.append(row);
  }

  // ===== 5. 守れていた振る舞い =====
  const kept = document.getElementById('kept');
  // notes に含まれるリグレ ID（H1, Q2, U1 など）を抽出
  const regressionTags = new Set();
  for (const p of passed) {
    const note = p.notes || '';
    const tags = note.match(/\b[A-Z]\d+\b/g) || [];
    tags.forEach(t => regressionTags.add(t));
  }
  const passByFeature = {};
  for (const p of passed) {
    passByFeature[p.feature] = passByFeature[p.feature] || [];
    passByFeature[p.feature].push(p);
  }
  let keptHtml = '';
  if (regressionTags.size) {
    keptHtml += `<p><span class="label">既知バグの再発防止</span>${[...regressionTags].sort().join(', ')} のリグレを再走で確認。</p>`;
  }
  const passedFeatNames = passedFeatures.map(f => `${f.name}（${f.totals.pass} 件）`);
  if (passedFeatNames.length) {
    keptHtml += `<p><span class="label">機能まるごと合格</span>${passedFeatNames.join('、')}</p>`;
  }
  if (!keptHtml) keptHtml = '<p class="cluster-meta">合格 TC がないため記載なし。</p>';
  kept.innerHTML = keptHtml;

  // ===== 6. 全テスト 横断一覧（1 行 1 TC、常時表示）=====
  const allBody = $('#all-tests-body');
  for (const f of state.features) {
    for (const t of f.cases) {
      const tr = el('tr');
      tr.dataset.status = t.status;
      tr.dataset.sev = t.severity;
      tr.dataset.search = `${t.id} ${t.title} ${t.category || ''} ${t.screen || ''} ${f.name} ${(t.notes||'')}`.toLowerCase();
      if (t.status === 'failed') tr.classList.add('row-failed');

      const tdId = el('td', { className: 'id' });
      tdId.append(el('a', { href: '#' + t.id, style: 'color:inherit' }, t.id));
      tr.append(tdId);
      tr.append(el('td', { className: 'cluster-meta', style: 'font-size:12px' }, f.id + ' ' + f.name));
      tr.append(el('td', {}, t.category || '—'));
      tr.append(el('td', {}, t.title));
      tr.append(el('td', {}, el('span', { className: 'sev sev-' + t.severity }, t.severity)));
      tr.append(el('td', {}, el('span', { className: 'pill p-' + t.status }, STATUS_JA[t.status] || t.status)));
      // 証拠列: passed は証拠必須。証拠なし passed は ⚠未証明 を赤で出す。
      const tdEv = el('td');
      const ec = evidenceCount(t);
      if (t.status === 'passed' && ec === 0) {
        tr.classList.add('row-unproven');
        tdEv.append(el('span', { className: 'pill', style: 'background:var(--red-bg);color:var(--red)' }, '⚠未証明'));
      } else if (ec > 0) {
        tdEv.append(el('span', { className: 'cluster-meta', title: '証拠 ' + ec + ' 件' }, '✓ ' + ec));
      } else {
        tdEv.append(el('span', { className: 'cluster-meta' }, '—'));
      }
      tr.append(tdEv);
      allBody.append(tr);
    }
  }

  // ===== 7. Feature details =====
  const featRoot = $('#features');
  for (const f of state.features) {
    const hasFail = f.cases.some(c => c.status === 'failed');
    const d = el('details', { open: hasFail, className: 'feature' + (hasFail ? ' has-fail' : '') });
    d.dataset.feature = f.id;
    const sum = el('summary');
    sum.append(document.createTextNode(`${f.id} ${f.name}`));
    const cnt = el('span', { className: 'feature-counts' });
    cnt.append(el('span', { className: 'ok' }, `合格 ${f.totals.pass}`));
    cnt.append(document.createTextNode(' / '));
    cnt.append(document.createTextNode(`計画 ${f.totals.planned}`));
    if (f.totals.fail) {
      cnt.append(document.createTextNode(' / '));
      cnt.append(el('span', { className: 'ng' }, `失敗 ${f.totals.fail}`));
    }
    sum.append(cnt);
    d.append(sum);

    const tbl = el('table');
    const thead = el('thead');
    const trh = el('tr');
    ['ID','画面/機能','観点','テスト項目','重要度','結果'].forEach(h => trh.append(el('th', {}, h)));
    thead.append(trh); tbl.append(thead);

    const tb = el('tbody');
    for (const t of f.cases) {
      const tr = el('tr');
      tr.id = t.id;
      tr.dataset.status = t.status;
      tr.dataset.sev = t.severity;
      tr.dataset.search = `${t.id} ${t.title} ${t.category} ${t.screen || ''} ${(t.notes||'')}`.toLowerCase();
      if (t.status === 'failed') tr.classList.add('row-failed');

      const tdId = el('td', { className: 'id' });
      tdId.append(t.id);
      tdId.append(el('a', { className: 'anchor', href: '#' + t.id, title: 'この TC へのリンクをコピー' }, '#'));
      tr.append(tdId);
      tr.append(el('td', {}, t.screen || f.name));
      tr.append(el('td', {}, t.category || '—'));
      const tdTitle = el('td');
      tdTitle.append(t.title);
      if (t.why) {
        tdTitle.append(el('div', { className: 'cluster-meta', style: 'margin-top:4px' }, t.why));
      }
      tr.append(tdTitle);
      tr.append(el('td', {}, el('span', { className: 'sev sev-' + t.severity }, t.severity)));
      tr.append(el('td', {}, el('span', { className: 'pill p-' + t.status }, STATUS_JA[t.status] || t.status)));
      tb.append(tr);

      if (t.failure) {
        const trF = el('tr'); trF.dataset.status = t.status; trF.dataset.search = tr.dataset.search;
        const td = el('td'); td.colSpan = 6;
        const box = el('div', { className: 'failure-detail' });
        const dl = el('dl');
        const add = (lbl, v) => { if (v) { dl.append(el('dt', {}, lbl)); dl.append(el('dd', {}, v)); } };
        add('要約', t.failure.summary);
        add('期待', t.failure.expected);
        add('実際', t.failure.actual);
        add('原因仮説', t.failure.hypothesis);
        add('回避策', t.failure.workaround);
        if (t.user_impact) add('実害', t.user_impact);
        if (t.failure.repro_steps?.length) {
          dl.append(el('dt', {}, '再現手順'));
          const dd = el('dd');
          const ol = el('ol');
          for (const s of t.failure.repro_steps) ol.append(el('li', {}, s));
          dd.append(ol); dl.append(dd);
        }
        box.append(dl);
        td.append(box); trF.append(td); tb.append(trF);
      }
    }
    tbl.append(tb); d.append(tbl); featRoot.append(d);
  }

  // ===== 7. Handoffs / Assumptions =====
  const HO_STATUS = { pending: '未対応', requested: '依頼済', answered: '回答済', skipped: 'スキップ' };
  const ho = $('#handoffs');
  if (!(state.human_handoffs||[]).length) ho.innerHTML = '<p class="cluster-meta">なし</p>';
  for (const h of (state.human_handoffs || [])) {
    const c = el('div', { className: 'mini-card' });
    c.append(el('div', { className: 'mc-id' }, h.id + ' ／ ' + (HO_STATUS[h.status] || h.status)));
    c.append(el('div', { style: 'font-weight:600;margin-top:4px' }, h.title));
    if (h.result) c.append(el('div', { className: 'cluster-meta', style: 'margin-top:4px' }, h.result));
    ho.append(c);
  }

  const as = $('#assumptions');
  if (!(state.assumptions||[]).length) as.innerHTML = '<p class="cluster-meta">なし</p>';
  for (const a of (state.assumptions || [])) {
    const c = el('div', { className: 'mini-card' });
    c.append(el('div', { className: 'mc-id' }, a.id + ' ／ ' + (a.verified ? '✓ 検証済' : '⚠ 未検証')));
    c.append(el('div', { style: 'margin-top:4px' }, a.text));
    as.append(c);
  }

  // ===== Filters + Search（全テスト一覧と詳細表 両方に適用）=====
  let curFilter = 'all', curQuery = '';
  function applyFilter() {
    const sel = '#all-tests-body tr[data-status], #features tbody tr[data-status]';
    for (const tr of document.querySelectorAll(sel)) {
      const okF = curFilter === 'all'
        || (curFilter === 'failed' && tr.dataset.status === 'failed')
        || (curFilter === 'passed' && tr.dataset.status === 'passed')
        || (curFilter === 'P0' && tr.dataset.sev === 'P0');
      const okQ = !curQuery || (tr.dataset.search || '').includes(curQuery);
      tr.style.display = (okF && okQ) ? '' : 'none';
    }
  }
  for (const b of document.querySelectorAll('.filter button')) {
    b.onclick = () => {
      document.querySelectorAll('.filter button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      curFilter = b.dataset.f;
      applyFilter();
    };
  }
  document.getElementById('q').oninput = (e) => {
    curQuery = e.target.value.trim().toLowerCase();
    applyFilter();
  };

  // ===== テスト仕様書ビュー（画面別シート / 9 列） =====
  (function () {
    const byScreen = {};
    for (const c of allCases) {
      const s = c.screen || c.featureName || 'その他';
      (byScreen[s] ||= []).push(c);
    }
    const screens = Object.keys(byScreen);
    const tabs = document.getElementById('sheet-tabs');
    const body = document.getElementById('sheet-body');
    if (!tabs || !body || !screens.length) return;
    const fmtSteps = (v) =>
      Array.isArray(v) ? v.map((s, i) => `${i + 1}. ${s}`).join('\n') : (v || '—');
    function render(screen) {
      body.innerHTML = '';
      byScreen[screen].forEach((c, i) => {
        const tr = el('tr');
        for (const v of [c.id || String(i + 1), screen, c.category || '—', c.title || '',
          c.preconditions || '—', fmtSteps(c.steps), c.expected || '—']) {
          tr.append(el('td', {}, v));
        }
        const st = el('td');
        st.append(el('span', { className: 'qa-pill ' + (c.status || 'planned') },
          STATUS_JA[c.status] || c.status || '未実施'));
        tr.append(st);
        tr.append(el('td', {}, c.notes || ''));
        body.append(tr);
      });
      for (const b of tabs.children) b.classList.toggle('active', b.dataset.s === screen);
    }
    screens.forEach((s, idx) => {
      const fails = byScreen[s].filter((c) => c.status === 'failed').length;
      const b = el('button', { className: 'sheet-tab' + (idx === 0 ? ' active' : '') },
        s + (fails ? ` (${fails}✗)` : ''));
      b.dataset.s = s;
      b.onclick = () => render(s);
      tabs.append(b);
    });
    render(screens[0]);
  })();
</script>
</body>
</html>
