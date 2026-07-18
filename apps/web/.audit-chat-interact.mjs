// S-E01 挙動検証: 検索フィルタ / ペイントグル / メッセージ送信
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
// 1. 検索フィルタ
await page.getByLabel('スレッドを検索').fill('競合');
await page.waitForTimeout(400);
await page.screenshot({ path: `${SCRATCH}/shots/c1-search.png` });
await page.getByLabel('スレッドを検索').fill('');
// 2. 右ペイン閉じる
await page.getByLabel('コンテキストパネルを開閉').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SCRATCH}/shots/c2-right-closed.png` });
await page.getByLabel('コンテキストパネルを開閉').click();
// 3. メッセージ送信 (Enter) — LLM 未設定なら error 表示が誠実挙動
await page.getByLabel('メッセージを入力').fill('ヒアリング質問リストの初稿を見せて');
await page.keyboard.press('Enter');
await page.waitForTimeout(4000);
await page.screenshot({ path: `${SCRATCH}/shots/c3-send.png` });
await browser.close();
console.log('done');
