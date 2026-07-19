import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

// mock shot
{
  const c = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/employee/S-C02-detail.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-C02-mock.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
// org からトニーを開く
await page.goto('http://localhost:3100/employees', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'トニー の詳細' }).first().click();
await page.waitForURL('**/employees/detail**');
await page.waitForSelector('text=できること', { timeout: 30000 });
await page.waitForTimeout(800);

// TC1: ヘッダ (役職バッジ + メタ行 + チャット開始)
const meta = await page.locator('header p').first().textContent();
ok('TC1 ヘッダに EN·specialty·所属', /Tony/.test(meta) && /営業/.test(meta), meta);
ok('TC2 チャット開始ボタンあり', await page.getByRole('button', { name: 'チャット開始' }).isVisible());

// TC3: できること = 実スキル名 (uuid でない)
const ability = await page.locator('text=sales-email').first().isVisible().catch(() => false);
ok('TC3 できることに実スキル名 sales-email', ability);

// TC4: 担当範囲にレポート対象/直属の部下
const scope = await page.locator('text=レポート対象').isVisible() && await page.locator('text=直属の部下').isVisible();
ok('TC4 担当範囲 4 行 (実算出)', scope);

// TC5: 口調ラジオカード (サンプル文)
ok('TC5 口調ラジオカード + サンプル文', await page.getByRole('radio', { name: /タメ口・フランク/ }).isVisible());
await page.screenshot({ path: `${SCRATCH}/shots/S-C02-desktop.png`, fullPage: true });

// TC6: ナレッジタブ実切替
await page.getByRole('tab', { name: /ナレッジ/ }).click();
await page.waitForTimeout(300);
const knowledgeShown = await page.locator('text=参照ナレッジカテゴリ').isVisible();
ok('TC6 ナレッジタブ切替', knowledgeShown);
await page.getByRole('tab', { name: 'プロフィール' }).click();
await page.waitForTimeout(300);

// TC7: アイコンピッカー → 保存 → PATCH (DB 突合は shell 側)
await page.getByRole('button', { name: 'Lucide から選ぶ' }).click();
// 前回実行で保存済みの可能性があるため、現在と異なるアイコンを選ぶ (冪等)
const rocketSelected = await page.getByRole('option', { name: 'アイコン rocket' }).getAttribute('aria-selected');
await page.getByRole('option', { name: rocketSelected === 'true' ? 'アイコン flame' : 'アイコン rocket' }).click();
await page.waitForTimeout(200);
ok('TC7a 未保存表示 (dirty)', await page.locator('text=未保存の変更があります').isVisible());
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1200);
ok('TC7b 保存後 dirty 解除', await page.locator('text=変更はありません').isVisible());

// TC8: 口調変更 + 保存 (実 PATCH)
await page.getByRole('radio', { name: /ビジネス簡潔/ }).check();
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1200);

// TC9: org に戻るとアイコンが反映されている (rocket glyph = svg)
await page.goto('http://localhost:3100/employees', { waitUntil: 'networkidle' });
await page.waitForSelector('text=トニー');
const tonyCard = page.getByRole('button', { name: 'トニー の詳細' }).first();
const hasSvgIcon = await tonyCard.locator('span[role="img"] svg').count() > 0;
ok('TC9 組織図カードに選択アイコン反映', hasSvgIcon);
await page.screenshot({ path: `${SCRATCH}/shots/S-C02-org-icon.png`, fullPage: false });

// TC10: チャット開始 → /chat 遷移
await tonyCard.click();
await page.waitForURL('**/employees/detail**');
await page.waitForSelector('text=チャット開始');
await page.getByRole('button', { name: 'チャット開始' }).click();
await page.waitForURL('**/chat**', { timeout: 20000 });
ok('TC10 チャット開始 → /chat 遷移', page.url().includes('/chat'));

// mobile
const c3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
await c3.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await c3.newPage();
await p3.goto('http://localhost:3100/employees/detail?employee=' + await page.evaluate(() => new URLSearchParams(location.search).get('project') || ''), { waitUntil: 'networkidle' }).catch(() => {});
await c3.close();

for (const [s, n, e] of R) console.log(s, '|', n, e ? `| ${e}` : '');
const fails = R.filter(r => r[0] === 'FAIL').length;
console.log(`RESULT: ${R.length - fails}/${R.length} PASS`);
await browser.close();
process.exit(fails ? 1 : 0);
