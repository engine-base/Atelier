// S-F01 挙動検証: タブ切替 / 工程ノード選択 / モバイルドロワー / 404 特定
import { chromium } from '@playwright/test';
import fs from 'fs';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const URL = 'http://localhost:3100/workflow/s_f01?project=0a651a74-5dd8-4850-8c65-f1d92381d14e';
const out = `${SCRATCH}/shots`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
page.on('response', (r) => { if (r.status() >= 400) console.log('HTTP', r.status(), r.url()); });
await page.goto(URL, { waitUntil: 'networkidle' });

// 1. タブ切替: 議論中
await page.getByRole('tab', { name: /議論中/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/i1-tab-discussion.png` });

// 2. タブ切替: 関連タスク
await page.getByRole('tab', { name: /関連タスク/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/i2-tab-tasks.png` });

// 3. 工程ノード選択: 機能分解 (未着手ノード)
await page.getByRole('tab', { name: /機能分解/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/i3-select-phase5.png` });

// 4. モバイルドロワー
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await mctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const mp = await mctx.newPage();
await mp.goto(URL, { waitUntil: 'networkidle' });
await mp.getByRole('button', { name: 'メニュー' }).click();
await mp.waitForTimeout(400);
await mp.screenshot({ path: `${out}/i4-mobile-drawer.png` });

await browser.close();
console.log('done');
