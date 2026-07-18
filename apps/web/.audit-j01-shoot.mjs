import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
// mock
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
  const page = await ctx.newPage();
  await page.goto('file:///home/user/Atelier/06_mockups/inbox/S-J01-list.html', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${SCRATCH}/shots/S-J01-mock.png`, fullPage: true });
  await ctx.close();
}
for (const [w, h, name] of [[1440, 1000, 'desktop'], [768, 1000, 'tablet'], [390, 844, 'mobile']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto('http://localhost:3100/approvals', { waitUntil: 'networkidle' });
  await page.waitForSelector('text=承認 KPI', { state: 'attached', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // 詳細ペインを見せるため最初の緊急案件を選択 (desktop のみ)
  if (name === 'desktop') {
    await page.locator('button', { hasText: '判断する' }).first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: `${SCRATCH}/shots/S-J01-${name}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log('shots done');
