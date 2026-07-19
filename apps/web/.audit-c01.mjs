import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

// mock shot
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const pg = await ctx.newPage();
  await pg.goto('file:///home/user/Atelier/06_mockups/employee/S-C01-org.html', { waitUntil: 'networkidle' });
  await pg.screenshot({ path: `${SCRATCH}/shots/S-C01-mock.png`, fullPage: true });
  await ctx.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto('http://localhost:3100/employees', { waitUntil: 'networkidle' });
await page.waitForSelector('text=ジャービス', { timeout: 30000 });
await page.waitForTimeout(800);

// TC1: カードに役割・EN・スキル名 (実データ)
const cooCard = page.getByRole('button', { name: 'ジャービス の詳細' });
const cooText = await cooCard.textContent();
ok('TC1 COO カードに 役割 + EN + スキル名', /COO ·/.test(cooText) && /Jarvis/.test(cooText) && /skills ·/.test(cooText), cooText.slice(0, 80));

// TC2: 部署名がモック準拠
ok('TC2 部署名 (営業・契約部/開発・検証部)', await page.locator('text=営業・契約部').isVisible() && await page.locator('text=開発・検証部').isVisible());

await page.screenshot({ path: `${SCRATCH}/shots/S-C01-desktop.png`, fullPage: true });

// TC3: リストトグル → 実テーブル
await page.getByRole('button', { name: 'リスト' }).click();
await page.waitForTimeout(500);
const table = page.getByRole('table');
ok('TC3 リストビューに実テーブル', await table.isVisible());
const rows = await table.locator('tbody tr').count();
ok('TC4 リストに 10 名', rows === 10, `rows=${rows}`);
const toneCell = await table.locator('td', { hasText: '丁寧' }).first().isVisible().catch(() => false);
ok('TC5 口調プリセット実データ表示', toneCell);
await page.screenshot({ path: `${SCRATCH}/shots/S-C01-list.png`, fullPage: true });

// TC6: リスト行クリック → S-C02 遷移
await table.getByRole('button', { name: 'トニー の詳細' }).click();
await page.waitForURL('**/employees/detail**', { timeout: 20000 });
ok('TC6 リスト行クリック → 詳細遷移', page.url().includes('/employees/detail?employee='));
await page.goBack({ waitUntil: 'networkidle' });

// TC7: 組織図トグルへ戻す + カードクリック遷移
await page.getByRole('button', { name: '組織図' }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'ワンダ の詳細' }).click();
await page.waitForURL('**/employees/detail**', { timeout: 20000 });
ok('TC7 組織図カードクリック → 詳細遷移', page.url().includes('employee='));

// responsive shots
for (const [w, h, name] of [[768, 1000, 'tablet'], [390, 844, 'mobile']]) {
  const c2 = await browser.newContext({ viewport: { width: w, height: h } });
  await c2.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p2 = await c2.newPage();
  await p2.goto('http://localhost:3100/employees', { waitUntil: 'networkidle' });
  await p2.waitForSelector('text=ジャービス', { timeout: 30000 });
  const hasHScroll = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  ok(`TC8 ${name} 横スクロールなし`, !hasHScroll);
  await p2.screenshot({ path: `${SCRATCH}/shots/S-C01-${name}.png`, fullPage: true });
  await c2.close();
}

for (const [s, n, e] of R) console.log(s, '|', n, e ? `| ${e}` : '');
const fails = R.filter(r => r[0] === 'FAIL').length;
console.log(`RESULT: ${R.length - fails}/${R.length} PASS`);
await browser.close();
process.exit(fails ? 1 : 0);
