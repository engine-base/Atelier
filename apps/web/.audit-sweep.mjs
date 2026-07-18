// 死にクリック総当たりスイープ: 全 button/link/tab/checkbox を実クリックして効果を観測
import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const THREAD = 'ffccb405-9c33-4ee1-946e-7f37cc5319d0';
const SCREENS = [
  { id: 'S-B01', url: `/projects` },
  { id: 'S-B02', url: `/projects/dashboard?project=${PID}` },
  { id: 'S-F01', url: `/workflow?project=${PID}` },
  { id: 'S-I01', url: `/tasks?project=${PID}` },
  { id: 'S-E01', url: `/chat?project=${PID}&thread=${THREAD}` },
];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
let reqCount = 0;
let popupCount = 0;
page.on('request', (r) => { if (r.url().includes(':8000')) reqCount++; });
ctx.on('page', (p) => { popupCount++; p.close().catch(() => {}); });

const results = [];
const SEL = 'button:visible, a[href]:visible, [role="tab"]:visible, input[type="checkbox"]:visible';

// 前提ガード: サーバが落ちていて Chrome のエラーページを掃引する事故を防ぐ
async function assertAppAlive() {
  const res = await page.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
  if (!res || !res.ok()) throw new Error(`web server not healthy: ${res && res.status()}`);
  const brand = await page.locator('text=Atelier').first().isVisible().catch(() => false);
  if (!brand) throw new Error('app shell not rendered — got a non-app page; aborting sweep');
}
await assertAppAlive();
// route warm-up (dev server の初回コンパイル遅延で空描画を掴まないように)
for (const s of SCREENS) {
  await page.goto(`http://localhost:3100${s.url}`, { waitUntil: 'networkidle' }).catch(() => {});
}

for (const screen of SCREENS) {
  await page.goto(`http://localhost:3100${screen.url}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1800);
  const count = await page.locator(SEL).count();
  for (let i = 0; i < Math.min(count, 130); i++) {
    // 毎回 re-query (DOM が変わるため)
    const els = page.locator(SEL);
    const n = await els.count();
    if (i >= n) break;
    const el = els.nth(i);
    let name = '';
    let tag = '';
    let disabled = false;
    try {
      tag = await el.evaluate((e) => e.tagName.toLowerCase() + (e.getAttribute('role') === 'tab' ? '[tab]' : e.type === 'checkbox' ? '[checkbox]' : ''));
      name = (await el.evaluate((e) => (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 40))) || '(no name)';
      disabled = await el.evaluate((e) => e.disabled === true);
    } catch { continue; }
    if (disabled) { results.push({ screen: screen.id, name, tag, effect: 'disabled(仕様)' }); continue; }

    const beforeUrl = page.url();
    const beforeDom = await page.evaluate(() => document.body.innerHTML.length);
    const beforeAria = await el.evaluate((e) => `${e.getAttribute('aria-pressed')}|${e.getAttribute('aria-selected')}|${e.checked ?? ''}`).catch(() => '');
    reqCount = 0;
    popupCount = 0;
    try {
      await el.click({ timeout: 2000, trial: false });
    } catch { results.push({ screen: screen.id, name, tag, effect: 'クリック不可(非表示化?)' }); continue; }
    await page.waitForTimeout(1200);
    const afterUrl = page.url();
    let effect = [];
    if (afterUrl !== beforeUrl) effect.push(`遷移→${afterUrl.replace('http://localhost:3100', '').slice(0, 40)}`);
    const afterDom = await page.evaluate(() => document.body.innerHTML.length).catch(() => beforeDom);
    if (Math.abs(afterDom - beforeDom) > 50 && afterUrl === beforeUrl) effect.push('DOM変化');
    if (reqCount > 0) effect.push(`API×${reqCount}`);
    if (popupCount > 0) effect.push('新規タブ');
    if (afterUrl === beforeUrl) {
      const afterAria = await el.evaluate((e) => `${e.getAttribute('aria-pressed')}|${e.getAttribute('aria-selected')}|${e.checked ?? ''}`).catch(() => beforeAria);
      if (afterAria !== beforeAria) effect.push('aria変化');
    }
    results.push({ screen: screen.id, name, tag, effect: effect.length ? effect.join(' ') : '★効果なし' });
    // 後始末: モーダルを閉じ、別ページへ行ったら戻る
    await page.keyboard.press('Escape').catch(() => {});
    if (page.url() !== `http://localhost:3100${screen.url}` && !page.url().endsWith(screen.url)) {
      await page.goto(`http://localhost:3100${screen.url}`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(1000);
    }
  }
}
fs.writeFileSync(`${SCRATCH}/sweep.json`, JSON.stringify(results, null, 1));
const dead = results.filter((r) => r.effect === '★効果なし');
console.log(`total=${results.length} dead=${dead.length}`);
for (const d of dead) console.log('DEAD:', d.screen, d.tag, d.name);
await browser.close();
