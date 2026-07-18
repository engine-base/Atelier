import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const URL = 'http://localhost:3100/tasks?project=0a651a74-5dd8-4850-8c65-f1d92381d14e';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('text=クライアント初回ヒアリングの実施', { timeout: 20000 });
// 着手可カード 2 枚を選択
const boxes = page.getByRole('checkbox');
await boxes.nth(0).check();
await boxes.nth(1).check();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SCRATCH}/shots/i04-selected.png` });
// 選択を再生する → 実 POST /tasks/{id}/play ×2
await page.getByRole('button', { name: /選択を再生する/ }).click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${SCRATCH}/shots/i05-after-play.png`, fullPage: true });
await browser.close();
console.log('done');
