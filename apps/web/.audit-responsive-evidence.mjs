import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// S-K01 モバイル: ノード選択 → 本文へ自動スクロール + トグル崩れ解消の確認
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p = await ctx.newPage();
  await p.goto('http://localhost:3100/knowledge', { waitUntil: 'networkidle' });
  await p.waitForSelector('[role="treeitem"]', { timeout: 30000 });
  await p.getByRole('tab', { name: 'AI社員別' }).click();
  await p.waitForTimeout(700);
  await p.getByRole('treeitem', { name: 'Supabase RLS パターン' }).click();
  await p.waitForTimeout(1000);
  const noteInView = await p.locator('h2', { hasText: 'Supabase RLS パターン' }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= -50 && r.top < window.innerHeight;
  });
  console.log('S-K01 mobile: 選択→本文へ自動スクロール =', noteInView);
  // トグルの縦書き潰れ検査: ノートボタンの高さが 1 行分 (40px 未満) か
  const toggleH = await p.getByRole('button', { name: /^ノート$/ }).evaluate((el) => el.getBoundingClientRect().height);
  console.log('S-K01 mobile: ノートトグル高さ(px) =', toggleH, toggleH < 40 ? '(1行 OK)' : '(縦潰れ NG)');
  await p.screenshot({ path: `${SCRATCH}/shots/EVIDENCE-S-K01-mobile390.png`, fullPage: true });
  await ctx.close();
}

// 4 画面 × 390px のラベル付き証拠
const SCREENS = [
  ['S-J01', '/approvals', 'text=承認 KPI'],
  ['S-C01', '/employees', 'text=ジャービス'],
  ['S-C02', null, 'text=できること'], // C02 は C01 経由
];
for (const [id, url, sel] of SCREENS) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p = await ctx.newPage();
  if (id === 'S-C02') {
    await p.goto('http://localhost:3100/employees', { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'トニー の詳細' }).first().click();
    await p.waitForURL('**/employees/detail**');
  } else {
    await p.goto(`http://localhost:3100${url}`, { waitUntil: 'networkidle' });
  }
  await p.waitForSelector(sel, { state: 'attached', timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(1200);
  const hs = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  console.log(`${id} mobile390 横スクロール =`, hs ? 'NG' : 'なし OK');
  await p.screenshot({ path: `${SCRATCH}/shots/EVIDENCE-${id}-mobile390.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log('evidence shots done');
