// 画面監査用スクリーンショットドライバ
// usage: node shoot.mjs <url-path> <name> [--mock <mockup-file>]
import { chromium } from "@playwright/test";
import fs from 'fs';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const [, , urlPath, name, ...rest] = process.argv;
const mockIdx = rest.indexOf('--mock');
const mockFile = mockIdx >= 0 ? rest[mockIdx + 1] : null;

const VIEWPORTS = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'mobile', width: 390, height: 844 },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const outDir = `${SCRATCH}/shots`;
fs.mkdirSync(outDir, { recursive: true });

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  await ctx.addCookies([
    { name: 'atelier_access', value: token, domain: 'localhost', path: '/' },
  ]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:3100${urlPath}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${outDir}/${name}-${vp.label}.png`, fullPage: true });
  if (errors.length) console.log(`[${vp.label}] console errors:\n` + errors.slice(0, 10).join('\n'));
  await ctx.close();
}

if (mockFile) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`file://${mockFile}`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${outDir}/${name}-MOCK.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
console.log('done');
