import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

{
  const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/knowledge/S-K01-explorer.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-K01-mock.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto('http://localhost:3100/knowledge', { waitUntil: 'networkidle' });
await page.waitForSelector('[role="treeitem"]', { timeout: 30000 });
await page.waitForTimeout(800);

// TC1: 共通 scope ツリー (ルートのみ、子は重複表示されない)
const rootTitles = await page.locator('[role="treeitem"]').allTextContents();
ok('TC1 共通ツリーにルートのみ (子の重複なし)', rootTitles.some(t => t.includes('ユーザー方向性')) && !rootTitles.some(t => t.includes('品質最優先')), JSON.stringify(rootTitles.slice(0,4)));

// TC2: 展開で実子取得
await page.getByRole('treeitem', { name: 'ユーザー方向性' }).click();
await page.waitForTimeout(700);
ok('TC2 展開 → 子ノード遅延取得', await page.getByRole('treeitem', { name: '品質最優先の開発方針' }).isVisible());

// TC3: AI社員別 scope → 社員グルーピング (アバター見出し)
await page.getByRole('tab', { name: 'AI社員別' }).click();
await page.waitForTimeout(800);
const treePane = page.locator('section[aria-label="ナレッジエクスプローラ"] > aside').first();
const strangeHeader = await treePane.locator('text=ストレンジ').isVisible();
ok('TC3 AI社員別に社員見出しグルーピング', strangeHeader);

// TC4: ノート選択 → 本文 + メタ (オーナー実名 + 信頼度 + 関連ナレッジ)
await page.getByRole('treeitem', { name: 'Supabase RLS パターン' }).click();
await page.waitForTimeout(1000);
ok('TC4a 本文描画', await page.locator('h2', { hasText: 'Supabase RLS パターン' }).isVisible());
const metaPane = page.locator('aside').last();
ok('TC4b オーナー実名 (UUID でない)', await metaPane.locator('text=ストレンジ').isVisible());
ok('TC4c 信頼度 0.92', await metaPane.locator('text=0.92').first().isVisible());
const related = await metaPane.locator('text=関連ナレッジ').isVisible().catch(() => false);
ok('TC4d 関連ナレッジ (RAG) 表示', related);
await page.screenshot({ path: `${SCRATCH}/shots/S-K01-desktop.png`, fullPage: true });

// TC5: RAG 検索実行 → ヒット一覧 → クリア
await page.getByLabel('ナレッジを検索（RAG）').fill('RLS');
await page.getByLabel('ナレッジを検索（RAG）').press('Enter');
await page.waitForTimeout(1000);
const hits = await page.locator('text=検索結果').textContent();
ok('TC5a 検索結果表示', /検索結果 \d+ 件/.test(hits || ''), hits);
await page.screenshot({ path: `${SCRATCH}/shots/S-K01-search.png` });
await page.getByRole('button', { name: '検索をクリア' }).click();
await page.waitForTimeout(400);
ok('TC5b クリアでツリー復帰', await page.locator('[role="treeitem"]').count() > 0);

// TC6: リストビュー実切替
await page.getByRole('button', { name: /^リスト$/ }).click();
await page.waitForTimeout(500);
const table = page.getByRole('table');
ok('TC6 リストビュー実テーブル', await table.isVisible());
await page.screenshot({ path: `${SCRATCH}/shots/S-K01-list.png`, fullPage: true });
await page.getByRole('button', { name: /^ノート$/ }).click();
await page.waitForTimeout(300);

// TC7: 複製 → ツリーに「（複製）」が出る (DB 突合は shell)
await page.getByRole('treeitem', { name: 'LangGraph 人間承認ループ', exact: false }).first().click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: /複製/ }).click();
await page.waitForTimeout(1200);
ok('TC7 複製 → 実 POST + ツリー反映', await page.getByRole('treeitem', { name: /LangGraph 人間承認ループ（複製）/ }).isVisible());

// TC8: 複製ノートを削除 (2段階確認)
await page.getByRole('treeitem', { name: /（複製）/ }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: '削除' }).click();
await page.getByRole('button', { name: '削除する' }).click();
await page.waitForTimeout(1200);
ok('TC8 削除 → ツリーから消える', (await page.getByRole('treeitem', { name: /（複製）/ }).count()) === 0);

// TC9: パネル開閉
await page.getByRole('button', { name: 'ツリーパネルを開閉' }).click();
await page.waitForTimeout(300);
ok('TC9 左パネル開閉 (aria-pressed)', (await page.getByRole('button', { name: 'ツリーパネルを開閉' }).getAttribute('aria-pressed')) === 'true');
await page.getByRole('button', { name: 'ツリーパネルを開閉' }).click();

// responsive
for (const [w, h, name] of [[768, 1000, 'tablet'], [390, 844, 'mobile']]) {
  const c2 = await browser.newContext({ viewport: { width: w, height: h } });
  await c2.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p2 = await c2.newPage();
  await p2.goto('http://localhost:3100/knowledge', { waitUntil: 'networkidle' });
  await p2.waitForSelector('[role="treeitem"]', { timeout: 30000 });
  const hs = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  ok(`TC10 ${name} 横スクロールなし`, !hs);
  await p2.screenshot({ path: `${SCRATCH}/shots/S-K01-${name}.png`, fullPage: true });
  await c2.close();
}

for (const [s, n, e] of R) console.log(s, '|', n, e ? `| ${e}` : '');
const fails = R.filter(r => r[0] === 'FAIL').length;
console.log(`RESULT: ${R.length - fails}/${R.length} PASS`);
await browser.close();
process.exit(fails ? 1 : 0);
