/**
 * S-N01 商談ドラフト — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-n01.mjs
 * 注意: 監査用ドキュメントを作成し最後に物理削除する (自作データのみ破壊)。
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

// モック基準 (3 幅)
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1200 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/sales/S-N01-drafts.html', {
    waitUntil: 'networkidle',
  });
  await p.screenshot({ path: `${SCRATCH}/shots/S-N01-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// TC1: 到達性 — ダッシュボードのナビから「営業ドラフト」で到達 (v2 で導線新設)
await page.goto(`http://localhost:3100/projects/dashboard?project=${PID}`, {
  waitUntil: 'networkidle',
});
await page.getByRole('link', { name: '営業ドラフト' }).first().click();
await page.waitForSelector('text=提案 / 見積ドラフト', { timeout: 30000 });
ok('TC1 ナビ導線から到達 (到達不能画面の解消)', page.url().includes('/sales'), page.url());

// TC2: 実タブ (提案書/見積書) + 実件数バッジ
const propTab = page.getByRole('tab', { name: /提案書/ });
const estTab = page.getByRole('tab', { name: /見積書/ });
ok('TC2 タブが実 tab (aria-selected)', (await propTab.getAttribute('aria-selected')) === 'true');

// TC3: 提案ドラフト作成 → プレビュー + 履歴 + DB 突合
await page.getByLabel(/顧客名/).fill('監査商事');
await page.getByLabel(/^案件/).fill('監査案件A');
await page.getByLabel(/商談概要/).fill('デザイン監査のための十分に長い商談概要テキスト。');
await page.getByRole('button', { name: 'ドラフト生成' }).click();
await page.getByRole('article', { name: '生成ドラフト' }).waitFor({ timeout: 20000 });
const dbProp = sql(
  `select stage || '|' || version from workflow_outputs where project_id='${PID}' and stage='proposal' and summary like '%監査案件A%' and deleted_at is null`,
);
ok('TC3 作成 → DB (workflow_outputs stage=proposal)', dbProp.startsWith('proposal|'), `db=${dbProp}`);
ok('TC4 履歴に版数つきで反映', await page.locator('button', { hasText: '監査案件A' }).first().isVisible());
await page.screenshot({ path: `${SCRATCH}/shots/S-N01-desktop.png`, fullPage: true });

// TC5: 見積タブへ切替 → doc_type=estimate で作成
await estTab.click();
await page.getByLabel(/顧客名/).fill('監査商事');
await page.getByLabel(/^案件/).fill('監査見積B');
await page.getByLabel(/商談概要/).fill('見積ドラフト検証のための十分に長い概要テキスト。');
await page.getByRole('button', { name: 'ドラフト生成' }).click();
await page.waitForTimeout(1800);
const dbEst = sql(
  `select count(*) from workflow_outputs where project_id='${PID}' and stage='estimate' and summary like '%監査見積B%' and deleted_at is null`,
);
ok('TC5 タブ切替 → doc_type=estimate で保存', dbEst === '1', `rows=${dbEst}`);

// TC6: 編集 → PATCH → DB 反映 → リロード永続
await page.getByRole('button', { name: '編集' }).click();
await page.getByLabel('ドラフト本文').fill('# 監査見積B\n\n改訂済み本文 (design-audit)');
await page.getByRole('button', { name: '保存', exact: true }).click();
await page.waitForTimeout(1500);
const dbEdit = sql(
  `select count(*) from workflow_outputs where project_id='${PID}' and stage='estimate' and summary like '%改訂済み本文%' and deleted_at is null`,
);
ok('TC6 編集 → PATCH → DB 反映', dbEdit === '1', `rows=${dbEdit}`);
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('tab', { name: /見積書/ }).click();
await page.locator('button', { hasText: '監査見積B' }).first().click();
ok(
  'TC7 リロード後も保存済み一覧から開ける (旧実装はリロードで全消失)',
  await page.getByRole('article', { name: '生成ドラフト' }).locator('text=改訂済み本文').isVisible({ timeout: 15000 }),
);

// TC8: 修正依頼 → チャットへの実リンク
const chatHref = await page.getByRole('link', { name: /修正依頼/ }).getAttribute('href');
ok('TC8 修正依頼 = チャット実リンク', chatHref === `/chat?project=${PID}`, `href=${chatHref}`);

// TC9: 削除 2 段階 → DB 論理削除
const estRow = page.locator('li', { hasText: '監査見積B' });
await estRow.getByRole('button', { name: /を削除/ }).click();
ok('TC9 削除 1 クリック目は確認のみ', await estRow.getByRole('button', { name: '削除する' }).isVisible());
await estRow.getByRole('button', { name: '削除する' }).click();
await page.waitForTimeout(1500);
const dbDel = sql(
  `select deleted_at is not null from workflow_outputs where project_id='${PID}' and stage='estimate' and summary like '%改訂済み本文%'`,
);
ok('TC10 削除確定 → DB 論理削除', dbDel === 't', `deleted=${dbDel}`);

// レスポンシブ 768 / 390
for (const [w, tag] of [[768, 'tablet-768'], [390, 'mobile-390']]) {
  const c2 = await browser.newContext({ viewport: { width: w, height: 900 } });
  await c2.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p2 = await c2.newPage();
  await p2.goto(`http://localhost:3100/sales?project=${PID}`, { waitUntil: 'networkidle' });
  await p2.waitForSelector('text=提案 / 見積ドラフト', { timeout: 30000 });
  await p2.waitForTimeout(500);
  if (w === 390) {
    const hasHScroll = await p2.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    );
    ok('TC11 390px: body 横スクロールなし', !hasHScroll);
    await p2.getByRole('tab', { name: /見積書/ }).click();
    ok('TC12 390px: タブ操作可能', (await p2.getByRole('tab', { name: /見積書/ }).getAttribute('aria-selected')) === 'true');
  }
  await p2.screenshot({ path: `${SCRATCH}/shots/S-N01-${tag}.png`, fullPage: true });
  await c2.close();
}

await browser.close();
// 後片付け: 監査用ドキュメントを物理削除
sql(`delete from workflow_outputs where project_id='${PID}' and (summary like '%監査案件A%' or summary like '%監査見積B%')`);

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
