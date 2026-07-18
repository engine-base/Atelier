import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
// S-B01 modal Escape
await page.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /新規プロジェクト$/ }).first().click();
await page.getByRole('dialog', { name: '新規プロジェクト' }).waitFor();
await page.keyboard.press('Escape');
console.log('S-B01 modal after Escape =', await page.getByRole('dialog', { name: '新規プロジェクト' }).count());
// S-I01 add-task modal Escape + backdrop
await page.goto(`http://localhost:3100/tasks?project=${PID}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'タスクを追加' }).first().click();
await page.getByRole('dialog', { name: 'タスクを追加' }).waitFor();
await page.keyboard.press('Escape');
console.log('S-I01 modal after Escape =', await page.getByRole('dialog', { name: 'タスクを追加' }).count());
await page.getByRole('button', { name: 'タスクを追加' }).first().click();
await page.getByRole('dialog', { name: 'タスクを追加' }).waitFor();
await page.mouse.click(30, 30);
await page.waitForTimeout(300);
console.log('S-I01 modal after backdrop click =', await page.getByRole('dialog', { name: 'タスクを追加' }).count());
await browser.close();
