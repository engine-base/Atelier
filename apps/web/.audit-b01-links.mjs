import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.addInitScript((pid) => localStorage.setItem('atelier_current_project', pid), PID);
for (const label of ['シークレット', '設定']) {
  await page.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
  const link = page.locator('nav a', { hasText: label }).last();
  console.log(label, 'href =', await link.getAttribute('href'));
  await link.click();
  await page.waitForURL((u) => u.pathname !== '/projects', { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  const h1 = await page.locator('h1, h2').first().textContent().catch(() => '(no h1)');
  console.log(label, '→', page.url(), '| heading =', (h1 || '').trim().slice(0, 40));
}
await browser.close();
