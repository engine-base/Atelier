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

// 1. 成果物タブ (プレビューカード) — ヒアリング工程を選択して成果物ありの状態で
await page.getByRole('tab', { name: /ヒアリング/ }).click();
await page.waitForTimeout(300);
await page.getByRole('tab', { name: /成果物/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/i6-tab-outputs.png` });

// 2. 未確認タブ (要件定義選択状態)
await page.getByRole('tab', { name: /要件定義/ }).click();
await page.waitForTimeout(300);
await page.getByRole('tab', { name: /未確認/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/i7-tab-unresolved.png` });

// 3. 議論中 (メッセージ件数表示)
await page.getByRole('tab', { name: /議論中/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/i8-tab-discussion2.png` });

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
