import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

{
  const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/knowledge/S-K02-review.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-K02-mock.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto('http://localhost:3100/knowledge/review', { waitUntil: 'networkidle' }).catch(() => {});
// route 確認 (ROUTE_MAP に無ければ s_k02 直)
if (!(await page.locator('text=書込候補').isVisible().catch(() => false))) {
  await page.goto('http://localhost:3100/knowledge/s_k02', { waitUntil: 'networkidle' });
}
await page.waitForSelector('text=書込候補', { timeout: 30000 });
await page.waitForTimeout(1000);

// TC1: 候補 5 件 + バッジ (社員別は昇格不可表示)
const cards = await page.locator('section[aria-label="ナレッジ昇格レビュー"] ul[role="list"] > li').count();
ok('TC1 候補 5 件', cards === 5, `cards=${cards}`);
ok('TC2 社員別は「昇格不可」バッジ', await page.locator('text=社員別 (昇格不可)').isVisible());

// TC3: メタ行 + Markdown 本文 + 相対時刻
ok('TC3a メタ 4 列 (昇格先/カテゴリ/出典/信頼度)', await page.locator('text=昇格先').isVisible() && await page.locator('select').first().isVisible());
ok('TC3b Markdown 整形 (h2 共通パターン)', await page.locator('h3', { hasText: '共通パターン' }).isVisible());
await page.screenshot({ path: `${SCRATCH}/shots/S-K02-desktop.png`, fullPage: true });

// TC4: タグ追加/削除 (実編集)
await page.getByLabel('タグを追加').fill('sso');
await page.getByLabel('タグを追加').press('Enter');
ok('TC4a タグ追加', await page.locator('text=sso').isVisible());
await page.getByRole('button', { name: 'タグ sso を削除' }).click();
ok('TC4b タグ削除', (await page.locator('span', { hasText: /^sso$/ }).count()) === 0);

// TC5: タイトル編集 → dirty でボタン文言が変わる
await page.getByLabel('昇格候補タイトル').fill('3 案件共通：認証フローのベストプラクティス（改訂）');
ok('TC5 dirty で「編集を保存して書込」', await page.locator('button', { hasText: '編集を保存して書込' }).isVisible());

// TC6: 編集込みで昇格 → PATCH + promote → 一覧から消える (DB 突合は shell)
await page.getByRole('button', { name: /を昇格$/ }).click();
await page.waitForTimeout(1500);
ok('TC6 昇格 → 一覧から除外', (await page.locator('text=認証フローのベストプラクティス').count()) === 0);

// TC7: 却下 2 段階 → 実 DELETE
await page.locator('ul[role="list"] button', { hasText: 'Retry プロトコル' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /を却下$/ }).click();
await page.getByRole('button', { name: '却下して削除' }).click();
await page.waitForTimeout(1200);
ok('TC7 却下 → 実 DELETE で一覧から消える', (await page.locator('text=Retry プロトコル').count()) === 0);

// TC8: 一括承認 2 段階
await page.getByRole('button', { name: '一括承認' }).click();
const bulkBtn = page.getByRole('button', { name: /件を昇格/ });
ok('TC8a 一括は確認ステップ', await bulkBtn.isVisible());
await bulkBtn.click();
await page.waitForTimeout(1800);
// promotable 2 件 (業界傾向x1 + 横断テンプレx1) が消え、社員別のみ残る
const remaining = await page.locator('section[aria-label="ナレッジ昇格レビュー"] ul[role="list"] > li').count();
ok('TC8b 一括昇格後は社員別のみ残存', remaining === 1, `remaining=${remaining}`);

// responsive
for (const [w, h, name] of [[768, 1000, 'tablet'], [390, 844, 'mobile']]) {
  const c2 = await browser.newContext({ viewport: { width: w, height: h } });
  await c2.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p2 = await c2.newPage();
  await p2.goto(page.url(), { waitUntil: 'networkidle' });
  await p2.waitForSelector('text=書込候補', { timeout: 30000 });
  const hs = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  ok(`TC9 ${name} 横スクロールなし`, !hs);
  await p2.screenshot({ path: `${SCRATCH}/shots/S-K02-${name}.png`, fullPage: true });
  await c2.close();
}

for (const [s, n, e] of R) console.log(s, '|', n, e ? `| ${e}` : '');
const fails = R.filter(r => r[0] === 'FAIL').length;
console.log(`RESULT: ${R.length - fails}/${R.length} PASS`);
await browser.close();
process.exit(fails ? 1 : 0);
