/**
 * S-G01 成果物ビューア — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-g01.mjs
 *
 * 注意: dev では storage backend 未設定のため content-url は 503。ビューア本体
 *   (iframe) はこの環境では描画不能 → 画面は「保存先が未設定」の honest メッセージを出す。
 *   これは実装バグではなく dev インフラ制約。UI 配線は vitest (uc12 6 件) が担保する。
 *   本スクリプトはコメントパイプを API レベルで end-to-end 実証する (POST→GET→PATCH→DB)。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const api = async (method, path, body) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

// 対象 output (html_path あり)
const outputId = sql(`select id from workflow_outputs where project_id='${PID}' and html_path is not null and deleted_at is null limit 1`);
if (!outputId) { console.error('対象 output なし'); process.exit(1); }

// ── コメントパイプ API end-to-end (POST → GET → PATCH resolve → DB) ──
const uniq = `監査コメント ${Math.random().toString(36).slice(2, 7)}`;
const before = Number(sql(`select count(*) from comments where target_id='${outputId}' and target_type='workflow_output'`));
const created = await api('POST', '/comments', {
  target_type: 'workflow_output', target_id: outputId, content: uniq,
});
const cid = created.json?.data?.id;
ok('TC1 コメント投稿 → 201 + id', created.status === 201 && !!cid, `status=${created.status}`);

const listed = await api('GET', `/comments?target_type=workflow_output&target_id=${outputId}`);
const inList = Array.isArray(listed.json?.data) && listed.json.data.some((c) => c.content === uniq);
ok('TC2 一覧 (GET /comments) に反映', inList);

const dbStatus = sql(`select status from comments where id='${cid}'`);
ok('TC3 DB に open で永続', dbStatus === 'open', `db=${dbStatus}`);

const resolved = await api('PATCH', `/comments/${cid}`, { status: 'resolved' });
ok('TC4 解決 (PATCH status=resolved) → 200', resolved.status === 200, `status=${resolved.status}`);
ok('TC5 DB が resolved に', sql(`select status from comments where id='${cid}'`) === 'resolved');

// 後片付け (自作コメント削除)
await api('DELETE', `/comments/${cid}`);
ok('TC6 コメント数が元に戻る (自作データ削除)', Number(sql(`select count(*) from comments where target_id='${outputId}' and target_type='workflow_output' and status != 'deleted'`)) === before);

// ── UI: モック基準 + honest 503 メッセージ + 390px ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/output/S-G01-viewer.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-G01-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/outputs?output=${outputId}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
// dev は storage 503 → honest メッセージ (偽の空ビューアを出さない)
ok('TC7 storage 未設定を honest に明示 (503)', await page.locator('text=保存先が未設定').first().isVisible({ timeout: 15000 }).catch(() => false));
await page.screenshot({ path: `${SCRATCH}/shots/S-G01-desktop-503.png`, fullPage: true });

// output 未指定 → 案内
await page.goto('http://localhost:3100/outputs', { waitUntil: 'networkidle' });
ok('TC8 output 未指定は案内メッセージ', await page.locator('text=成果物を選択すると表示します').isVisible({ timeout: 10000 }).catch(() => false));

// 390px (503 状態でも横スクロールしない)
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto(`http://localhost:3100/outputs?output=${outputId}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(1500);
const hasHScroll = await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('TC9 390px 横スクロールなし', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-G01-mobile-390.png`, fullPage: true });
await m.close();
await ctx.close();
await browser.close();

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
