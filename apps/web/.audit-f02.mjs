/**
 * S-F02 フェーズ管理 — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-f02.mjs
 * 注意: 監査プロジェクトの phase 状態を一時変更し、最後に元へ戻す。
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

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// モック基準 (3 幅)
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1200 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/workflow/S-F02-phases.html', {
    waitUntil: 'networkidle',
  });
  await p.screenshot({ path: `${SCRATCH}/shots/S-F02-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/workflow/phases?project=${PID}`, {
  waitUntil: 'networkidle',
});
await page.locator('h1:has-text("フェーズ管理")').waitFor({ timeout: 30000 });

// TC1: タイムラインが DB のフェーズ数と一致
const dbCount = Number(sql(`select count(*) from phases where project_id='${PID}'`));
const uiCount = await page.locator('ol > li').count();
ok('TC1 タイムラインが実データ (DB 件数一致)', uiCount === dbCount && dbCount > 0, `ui=${uiCount} db=${dbCount}`);

// TC2: 期間 (started_at 〜 completed_at) が表示される (v2 で追加)
ok('TC2 期間表示 (YYYY-MM-DD 〜)', (await page.locator('text=/\\d{4}-\\d{2}-\\d{2} 〜/').count()) > 0);

// TC3: 統計が実カウントと一致
const doneDb = Number(sql(`select count(*) from phases where project_id='${PID}' and status='completed'`));
const statText = (await page.locator('dd').first().textContent()) || '';
ok('TC3 統計「確定フェーズ数」= DB completed 数', statText.includes(`${doneDb} /`), `stat="${statText}" db=${doneDb}`);
await page.screenshot({ path: `${SCRATCH}/shots/S-F02-desktop.png`, fullPage: true });

// TC4: 状態遷移 (select) → PATCH → DB 突合 → 元へ戻す
// pending の 1 フェーズを選び in_progress へ
const targetRow = sql(`select id, name, status from phases where project_id='${PID}' and status='pending' order by "order" limit 1`);
if (targetRow) {
  const [pid, pname, pstatus] = targetRow.split('|');
  const sel = page.getByLabel(`${pname} の状態`);
  await sel.selectOption('in_progress');
  await page.waitForTimeout(1500);
  const after = sql(`select status from phases where id='${pid}'`);
  ok('TC4 状態変更 select → PATCH → DB 反映', after === 'in_progress', `db=${after}`);
  // 元へ戻す
  await sel.selectOption('pending');
  await page.waitForTimeout(1200);
  ok('TC5 元の状態へ戻せる (往復)', sql(`select status from phases where id='${pid}'`) === pstatus, `restored=${sql(`select status from phases where id='${pid}'`)}`);
} else {
  ok('TC4 状態変更 select → PATCH → DB 反映', false, 'pending phase なし');
  ok('TC5 元の状態へ戻せる (往復)', false, 'skipped');
}

// TC6: done フェーズの番号が ✓ 表示
ok('TC6 完了フェーズは ✓ バッジ', (await page.locator('ol > li:has-text("完了") >> text=✓').count()) > 0);

// 390px
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto(`http://localhost:3100/workflow/phases?project=${PID}`, { waitUntil: 'networkidle' });
await p3.locator('h1:has-text("フェーズ管理")').waitFor({ timeout: 30000 });
await p3.waitForTimeout(800);
const hasHScroll = await p3.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
);
ok('TC7 390px 横スクロールなし', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-F02-mobile-390.png`, fullPage: true });
await m.close();
await ctx.close();
await browser.close();

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
