/**
 * S-H01 モックビューア — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-h01.mjs
 *
 * 注意: dev では storage backend 未設定のため content-url は 503。S-H01 は frame
 *   領域のみ honest メッセージを出し、バージョン履歴/コメントパネルは実 API で
 *   動作する (S-G01 と異なりメタ系がページ全面エラーにならない設計)。
 *   本スクリプトは mocks CRUD + バージョンチェーン + コメントパイプを
 *   API/UI 両レベルで end-to-end 実証し、使い捨てデータは最後に削除する。
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

// ── mocks CRUD + バージョンチェーン (API → DB 突合) ──
const screenName = `監査 ログイン画面 ${Math.random().toString(36).slice(2, 7)}`;
const v1res = await api('POST', '/mocks', {
  project_id: PID,
  screen_name: screenName,
  html_storage_path: 'mocks/audit-login-v1.html',
});
const v1 = v1res.json?.data?.id;
ok('TC1 モック作成 → 201 + version=1', v1res.status === 201 && v1res.json?.data?.version === 1, `status=${v1res.status}`);

const v2res = await api('POST', `/mocks/${v1}/versions`, {
  html_storage_path: 'mocks/audit-login-v2.html',
  meta_tags: { note: '+ エラーバナー追加' },
});
const v2 = v2res.json?.data?.id;
ok(
  'TC2 新バージョン作成 → 201 + version=2 + parent 連結',
  v2res.status === 201 && v2res.json?.data?.version === 2 && v2res.json?.data?.parent_mock_id === v1,
  `status=${v2res.status}`,
);
ok('TC3 DB 突合 (v2 行: version/parent)', sql(`select version::text || '|' || parent_mock_id from mocks where id='${v2}'`) === `2|${v1}`);

const chain = await api('GET', `/mocks/${v2}/versions`);
ok('TC4 バージョンチェーン API が 2 件返す', Array.isArray(chain.json?.data) && chain.json.data.length === 2);

ok(
  'TC5 audit_logs に mock.create / mock.version_create',
  sql(`select count(*) from audit_logs where action='mock.create' and target_id='${v1}'`) === '1' &&
    sql(`select count(*) from audit_logs where action='mock.version_create' and target_id='${v2}'`) === '1',
);

const cu = await api('GET', `/mocks/${v2}/content-url`);
ok('TC6 content-url は dev で honest 503', cu.status === 503, `status=${cu.status}`);

// ── コメントパイプ (API: POST → DB open) — 解決は UI 側で実施 ──
const apiCommentText = `監査コメント ${Math.random().toString(36).slice(2, 7)}`;
const cRes = await api('POST', '/comments', {
  target_type: 'mock',
  target_id: v2,
  content: apiCommentText,
});
const apiCid = cRes.json?.data?.id;
ok('TC7 コメント投稿 (target_type=mock) → 201', cRes.status === 201 && !!apiCid, `status=${cRes.status}`);
ok('TC8 DB に open で永続', sql(`select status from comments where id='${apiCid}'`) === 'open');

// ── UI: モック基準スクリーンショット ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/mock/S-H01-viewer.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-H01-${tag}.png`, fullPage: true });
  await c.close();
}

// ── UI: ビューア実操作 (1440) ──
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/mocks?mock=${v2}&project=${PID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

ok('TC9 見出し = screen_name', await page.getByRole('heading', { name: screenName }).isVisible().catch(() => false));
ok('TC10 バージョンピル「v2 · 最新」', await page.getByText('v2 · 最新').isVisible().catch(() => false));
ok('TC11 バージョン履歴（2）+ 表示中マーク', await page.getByRole('heading', { name: 'バージョン履歴（2）' }).isVisible().catch(() => false) && await page.getByText('表示中').isVisible().catch(() => false));
ok('TC12 meta_tags.note を変更概要として表示', await page.getByText('+ エラーバナー追加').isVisible().catch(() => false));
ok('TC13 storage 未設定を frame 領域で honest に明示', await page.getByRole('alert').filter({ hasText: '保存先が未設定' }).isVisible().catch(() => false));
ok('TC14 URL 無しの間は 新規タブ/HTML リンク非描画 (Rule 10)', (await page.getByRole('link', { name: /新規タブ/ }).count()) === 0);
ok('TC15 修正依頼 → プロジェクトチャット導線', (await page.getByRole('link', { name: '修正依頼' }).getAttribute('href')) === `/chat?project=${PID}`);
ok('TC16 サイドバーに「モック」ナビ (到達不能是正)', await page.getByRole('link', { name: 'モック', exact: true }).first().isVisible().catch(() => false));
await page.screenshot({ path: `${SCRATCH}/shots/S-H01-desktop-1440.png`, fullPage: true });

// コメント追加 (UI → DB 突合)
const uiCommentText = `UI コメント ${Math.random().toString(36).slice(2, 7)}`;
await page.getByPlaceholder('コメントを追加…').fill(uiCommentText);
await page.getByRole('button', { name: 'コメント', exact: true }).click();
await page.waitForTimeout(1500);
const uiCid = sql(`select id from comments where target_type='mock' and target_id='${v2}' and content='${uiCommentText}'`);
ok('TC17 UI からのコメント追加が DB に永続', !!uiCid);

// コメント解決 (UI → DB 突合): 最初の 解決にする = API 作成コメント
await page.getByRole('button', { name: '解決にする' }).first().click();
await page.waitForTimeout(1500);
ok('TC18 UI からの解決が DB で resolved に', sql(`select status from comments where id='${apiCid}'`) === 'resolved');
ok('TC19 未解決バッジが残 1 件に更新', await page.getByText('未解決 1').isVisible().catch(() => false));

// 旧バージョンへの遷移
await page.locator(`a[href="/mocks?mock=${v1}"]`).click();
await page.waitForURL((u) => u.pathname === '/mocks' && u.searchParams.get('mock') === v1, { timeout: 15000 });
await page.waitForTimeout(1500);
ok('TC20 旧版 v1 へ遷移 (バージョンカードリンク)', true);
ok('TC21 旧版表示では「最新」ピルを出さない', (await page.getByText('v1 · 最新').count()) === 0 && (await page.getByText('v2 · 最新').count()) === 0);

// 一覧ピッカー (?mock 無し)
await page.goto(`http://localhost:3100/mocks?project=${PID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const card = page.getByRole('link', { name: new RegExp(screenName) });
ok('TC22 一覧ピッカーに最新版カード (v2 リンク)', (await card.getAttribute('href').catch(() => null)) === `/mocks?mock=${v2}`);
await page.screenshot({ path: `${SCRATCH}/shots/S-H01-list-1440.png`, fullPage: true });
await card.click();
await page.waitForURL((u) => u.pathname === '/mocks' && u.searchParams.get('mock') === v2, { timeout: 15000 });
ok(
  'TC23 カードからビューアへ遷移',
  await page
    .getByRole('heading', { name: screenName })
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => true)
    .catch(() => false),
);
await ctx.close();

// ── 390px (横スクロールなし + 目視用ショット) ──
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto(`http://localhost:3100/mocks?mock=${v2}&project=${PID}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(2000);
const hasHScroll = await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('TC24 390px 横スクロールなし', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-H01-mobile-390.png`, fullPage: true });
await m.close();
await browser.close();

// ── 後片付け (自作データ削除 → DB 突合) ──
for (const cid of [apiCid, uiCid].filter(Boolean)) await api('DELETE', `/comments/${cid}`);
const d2 = await api('DELETE', `/mocks/${v2}`);
const d1 = await api('DELETE', `/mocks/${v1}`);
ok(
  'TC25 自作モック削除 (204 + deleted_at)',
  d2.status === 204 && d1.status === 204 &&
    sql(`select count(*) from mocks where id in ('${v1}','${v2}') and deleted_at is null`) === '0',
);

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
