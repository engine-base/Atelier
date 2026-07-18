// S-F01 工程遷移の実挙動検証: ヒアリング完了 → 要件定義 進行中
import { chromium } from '@playwright/test';
import fs from 'fs';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const URL = 'http://localhost:3100/workflow/s_f01?project=0a651a74-5dd8-4850-8c65-f1d92381d14e';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });

await page.getByRole('button', { name: 'この工程を完了して次へ' }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SCRATCH}/shots/i5-after-advance.png` });
await browser.close();
console.log('done');
