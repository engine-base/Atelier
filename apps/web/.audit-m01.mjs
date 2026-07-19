import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

{
  const c = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/upload/S-M01-meeting.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-M01-mock.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/meetings?project=${PID}`, { waitUntil: 'networkidle' });
await page.waitForSelector('text=議事録 / 商談アップロード', { timeout: 30000 });
await page.waitForTimeout(1000);

// TC1: 履歴 4 件 + 状態 pill
const rows = await page.locator('ul[aria-label="アップロード履歴"] > li').count();
ok('TC1 履歴 4 件 (実 GET /meetings)', rows === 4, `rows=${rows}`);
ok('TC2 状態 pill (解析中/完了/エラー)', await page.locator('text=解析中').first().isVisible() && (await page.locator('text=完了').count()) >= 2 && await page.locator('text=エラー').first().isVisible());
ok('TC3 サイズ表記 (218.0 MB)', await page.locator('text=218.0 MB').isVisible());
await page.screenshot({ path: `${SCRATCH}/shots/S-M01-desktop.png`, fullPage: true });

// TC4: 完了ファイル名クリック → transcript-url (storage 未設定環境では明示エラー)
await page.getByRole('button', { name: '2026-07-14_komatsu_meeting.mp4', exact: true }).click();
await page.waitForTimeout(1500);
const alertShown = await page.getByRole('alert').filter({ hasText: /失敗/ }).isVisible().catch(() => false);
ok('TC4 完了ファイルを開く → storage 未設定は明示エラー (握り潰さない)', alertShown, (await page.getByRole('alert').filter({ hasText: /失敗/ }).textContent().catch(() => '')).slice(0, 40));

// TC5: エラー行に理由表示
ok('TC5 エラー行に失敗理由', await page.locator('text=音声が不明瞭のため解析できませんでした').isVisible());

// TC6: dropzone drag-over 状態 (dispatchEvent)
const dz = page.locator('label', { has: page.getByLabel('音声・動画・テキストファイルを選択') });
await dz.evaluate((el) => {
  const dt = new DataTransfer();
  el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
});
await page.waitForTimeout(200);
const dzClass = await dz.getAttribute('class');
ok('TC6 drag-over で強調表示', (dzClass || '').includes('border-primary'));
await dz.evaluate((el) => el.dispatchEvent(new DragEvent('dragleave', { bubbles: true })));

// TC7: 削除 2 段階 → 実 DELETE
const delBtn = page.getByRole('button', { name: '2026-07-11_team_sync.mp3 を削除' });
await delBtn.first().click();
await delBtn.first().click();
await page.waitForTimeout(1200);
ok('TC7 削除 (2段階) → 一覧から消える', (await page.locator('text=2026-07-11_team_sync.mp3').count()) === 0);

// responsive
for (const [w, h, name] of [[768, 1000, 'tablet'], [390, 844, 'mobile']]) {
  const c2 = await browser.newContext({ viewport: { width: w, height: h } });
  await c2.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p2 = await c2.newPage();
  await p2.goto(`http://localhost:3100/meetings?project=${PID}`, { waitUntil: 'networkidle' });
  await p2.waitForSelector('text=議事録 / 商談アップロード', { timeout: 30000 });
  const hs = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  ok(`TC8 ${name} 横スクロールなし`, !hs);
  await p2.screenshot({ path: `${SCRATCH}/shots/S-M01-${name}.png`, fullPage: true });
  await c2.close();
}

for (const [s, n, e] of R) console.log(s, '|', n, e ? `| ${e}` : '');
const fails = R.filter(r => r[0] === 'FAIL').length;
console.log(`RESULT: ${R.length - fails}/${R.length} PASS`);
await browser.close();
process.exit(fails ? 1 : 0);
