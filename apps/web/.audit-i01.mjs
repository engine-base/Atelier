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
await page.screenshot({ path: `${SCRATCH}/shots/i01-v2.png`, fullPage: true });
// タスクは全部 triage(準備中)。まず1件を ready に上げる必要がある — bulk API を UI 外から?
// いや、準備中→着手可の UI 操作は S-I02 詳細の領分。ここでは checkbox は ready のみ。
// → seed 済み ready がないので、追加モーダルで新タスク作成(実POST)を検証
await page.getByRole('button', { name: 'タスクを追加' }).click();
await page.waitForTimeout(300);
await page.getByLabel(/タイトル/).fill('決済フロー要件の整理');
await page.locator('input[placeholder="hearing 等"]').fill('requirements');
await page.getByRole('button', { name: '作成', exact: true }).click();
await page.waitForTimeout(2000);
await page.screenshot({ path: `${SCRATCH}/shots/i02-added.png`, fullPage: true });
// リスト表示切替
await page.getByRole('button', { name: 'リスト' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${SCRATCH}/shots/i03-list.png`, fullPage: true });
await browser.close();
console.log('done');
