import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
const pill = page.getByRole('button', { name: /^ワークスペース: / });
console.log('pill visible =', await pill.isVisible());
await pill.click();
const listbox = page.getByRole('listbox', { name: 'ワークスペースを選択' });
await listbox.waitFor({ state: 'visible', timeout: 5000 });
const options = await listbox.getByRole('option').allTextContents();
console.log('options =', JSON.stringify(options));
const selected = await listbox.locator('[aria-selected="true"]').textContent();
console.log('selected =', (selected || '').trim());
await page.screenshot({ path: `${SCRATCH}/shots/topbar-ws-dropdown.png` });
// 選択 → localStorage 永続を確認
await listbox.getByRole('option').first().click();
const stored = await page.evaluate(() => localStorage.getItem('atelier_current_workspace'));
console.log('localStorage atelier_current_workspace =', stored);
// 通知ベルが存在しないこと (GAP-007 撤去確認)
console.log('bell count =', await page.getByRole('button', { name: '通知' }).count());
// アバターが実プロフィール
const avatar = page.locator('[aria-label^="サインイン中"]');
console.log('avatar label =', await avatar.getAttribute('aria-label').catch(() => '(none)'));
await browser.close();
