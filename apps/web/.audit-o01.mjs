import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

{
  const c = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/cron/S-O01-schedule.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-O01-mock.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/schedules?project=${PID}`, { waitUntil: 'networkidle' }).catch(() => {});
if (!(await page.locator('text=自動スケジュール').first().isVisible().catch(() => false))) {
  await page.goto(`http://localhost:3100/cron/s_o01?project=${PID}`, { waitUntil: 'networkidle' });
}
await page.waitForSelector('text=次に動くスケジュール', { timeout: 30000 });
await page.waitForTimeout(800);

// TC1: upcoming 時系列 (有効 4 件、相対時刻)
const upcoming = await page.locator('ol > li').count();
ok('TC1 upcoming に有効ジョブのみ時系列表示', upcoming === 4, `rows=${upcoming}`);
ok('TC2 相対時刻表示 (あと N 時間)', /あと \d+ 時間/.test(await page.locator('ol > li').first().textContent() || ''));

// TC3: グループ 3 種 + 人間可読 cron
ok('TC3 カテゴリ別グループ', await page.locator('text=実装の夜間自動進行').isVisible() && await page.locator('text=ナレッジ整理（ティチャラ）').isVisible() && await page.locator('text=通知・レポート配信').isVisible());
ok('TC4 cron 日本語ラベル', (await page.locator('text=毎日 深夜 2:00').count()) > 0 && (await page.locator('text=毎週 月曜 4:00').count()) > 0);
await page.screenshot({ path: `${SCRATCH}/shots/S-O01-desktop.png`, fullPage: true });

// TC5: トグル OFF → 楽観反映 + upcoming から消える (PATCH 実 API)
await page.getByLabel('ナレッジを自動で整理する を 無効 化').click();
await page.getByLabel('ナレッジを自動で整理する を 有効 化').waitFor({ timeout: 15000 });
await page.waitForTimeout(600);
const upAfter = await page.locator('ol > li').count();
ok('TC5 トグル OFF → upcoming から除外', upAfter === 3, `rows=${upAfter}`);
await page.getByLabel('ナレッジを自動で整理する を 有効 化').click();
await page.getByLabel('ナレッジを自動で整理する を 無効 化').waitFor({ timeout: 15000 });

// TC6: 更新ボタン → API 再取得
let reqs = 0;
page.on('request', (r) => { if (r.url().includes('/cron-schedules')) reqs++; });
await page.getByRole('button', { name: '更新' }).click();
await page.waitForTimeout(800);
ok('TC6 更新 → 再取得 API 発火', reqs > 0, `reqs=${reqs}`);

// TC7: builder で新規作成 (実 POST)
await page.getByLabel('1. 名前').fill('監査用 日次ダイジェスト');
await page.getByRole('button', { name: /日次ダイジェストを配信する/ }).click();
await page.getByRole('button', { name: '毎日 深夜 3:00' }).click();
await page.getByRole('button', { name: /このスケジュールを作成/ }).click();
await page.waitForTimeout(1500);
ok('TC7 新規作成 → 一覧に反映', (await page.locator('text=監査用 日次ダイジェスト').count()) > 0);

// TC8: 削除 2 段階
const delBtns = page.getByRole('button', { name: '監査用 日次ダイジェスト を削除' });
await delBtns.first().click();
await delBtns.first().click();
await page.waitForTimeout(1200);
ok('TC8 削除 (2段階) → 一覧から消える', (await page.locator('text=監査用 日次ダイジェスト').count()) === 0);

// responsive
for (const [w, h, name] of [[768, 1000, 'tablet'], [390, 844, 'mobile']]) {
  const c2 = await browser.newContext({ viewport: { width: w, height: h } });
  await c2.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p2 = await c2.newPage();
  await p2.goto(page.url(), { waitUntil: 'networkidle' });
  await p2.waitForSelector('text=次に動くスケジュール', { timeout: 30000 });
  const hs = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  ok(`TC9 ${name} 横スクロールなし`, !hs);
  await p2.screenshot({ path: `${SCRATCH}/shots/S-O01-${name}.png`, fullPage: true });
  await c2.close();
}

for (const [s, n, e] of R) console.log(s, '|', n, e ? `| ${e}` : '');
const fails = R.filter(r => r[0] === 'FAIL').length;
console.log(`RESULT: ${R.length - fails}/${R.length} PASS`);
await browser.close();
process.exit(fails ? 1 : 0);
