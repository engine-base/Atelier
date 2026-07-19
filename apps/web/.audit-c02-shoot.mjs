import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
// employee id を org API から
const PID = null;
for (const [w, h, name] of [[1440, 1100, 'desktop'], [768, 1000, 'tablet'], [390, 844, 'mobile']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  await page.goto('http://localhost:3100/employees', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'トニー の詳細' }).first().click();
  await page.waitForURL('**/employees/detail**');
  await page.waitForSelector('text=できること', { timeout: 30000 });
  await page.waitForTimeout(800);
  const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  console.log(name, 'hScroll =', hasHScroll);
  await page.screenshot({ path: `${SCRATCH}/shots/S-C02-${name}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log('shots done');
