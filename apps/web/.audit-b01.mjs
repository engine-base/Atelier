import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
await page.waitForSelector('text=ECサイトリニューアル', { timeout: 15000 });
// 1. 新規プロジェクト作成モーダル → 実 POST
await page.getByRole('button', { name: '新規プロジェクト', exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SCRATCH}/shots/p1-create-modal.png` });
await page.getByLabel(/プロジェクト名|名前/).fill('社内ナレッジポータル構築');
const sel = page.locator('select').first();
if (await sel.count()) await sel.selectOption({ index: 1 }).catch(() => {});
await page.getByRole('button', { name: /作成/ }).last().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SCRATCH}/shots/p2-after-create.png` });
// 2. 検索フィルタ
await page.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
await page.getByPlaceholder(/プロジェクトを検索/).fill('EC');
await page.waitForTimeout(400);
await page.screenshot({ path: `${SCRATCH}/shots/p3-search.png` });
await page.getByPlaceholder(/プロジェクトを検索/).fill('');
// 3. カードクリック → ダッシュボード遷移
await page.getByText('ECサイトリニューアル').first().click();
await page.waitForTimeout(2500);
console.log('after card click url =', page.url());
await page.screenshot({ path: `${SCRATCH}/shots/p4-card-nav.png` });
await browser.close();
console.log('done');
