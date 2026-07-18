// @メンション / ナレッジ参照ピッカーの実挙動検証
import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const URL = 'http://localhost:3100/chat?project=0a651a74-5dd8-4850-8c65-f1d92381d14e&thread=ffccb405-9c33-4ee1-946e-7f37cc5319d0';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('text=スティーブ', { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(800);
// 1. @メンション: ピッカーを開いてワンダを挿入
await page.getByLabel('メッセージを入力').fill('この件、');
await page.getByRole('button', { name: '@メンション' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SCRATCH}/shots/m1-mention-picker.png` });
await page.getByRole('option', { name: /ワンダ/ }).click();
await page.waitForTimeout(200);
const val = await page.getByLabel('メッセージを入力').inputValue();
console.log('textarea after mention =', JSON.stringify(val));
// 2. ナレッジ参照ピッカー (0件の誠実表示)
await page.getByRole('button', { name: 'ナレッジ参照' }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: `${SCRATCH}/shots/m2-knowledge-picker.png` });
// 3. 添付・/コマンドボタンが存在しないこと
const attach = await page.getByRole('button', { name: '添付' }).count();
const cmd = await page.getByRole('button', { name: '/コマンド' }).count();
console.log('添付 buttons =', attach, '/コマンド buttons =', cmd);
await browser.close();
console.log('done');
