/**
 * S-B03 プロジェクト設定 — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 対象 project: ECサイトリニューアル (0a651a74-…, status=draft のまま維持すること)。
 * 実行: node .audit-b03.mjs
 *
 * 注意: TC は DB を書き換える (client_name / 種別 / AI 学習)。終了時に元値へ戻す。
 * 削除 TC はキャンセル経路のみ (監査プロジェクトを消さない)。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

// モック基準スクリーンショット (3 幅)
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1200 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/project/S-B03-settings.html', {
    waitUntil: 'networkidle',
  });
  await p.screenshot({ path: `${SCRATCH}/shots/S-B03-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/projects/settings?project=${PID}`, {
  waitUntil: 'networkidle',
});
await page.waitForSelector('text=プロジェクト設定', { timeout: 30000 });
await page.getByLabel(/プロジェクト名/).waitFor({ timeout: 30000 });

// TC1: GET 実値がフォームへ (name / 種別 / ステータス=draft が丸められない)
ok('TC1 名前が実 API 値', (await page.getByLabel(/プロジェクト名/).inputValue()) === 'ECサイトリニューアル');
ok('TC2 種別 select が実値 (クライアント案件)', (await page.getByLabel(/種別/).inputValue()) === 'client_project');
ok('TC3 ステータス draft が丸められず表示', (await page.getByLabel(/ステータス/).inputValue()) === 'draft');

await page.screenshot({ path: `${SCRATCH}/shots/S-B03-desktop.png`, fullPage: true });

// TC4: クライアント名を編集 → 保存 → PATCH → DB 突合 → リロード永続
await page.getByLabel(/クライアント名/).fill('監査クライアント株式会社');
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1500);
const dbClient = sql(`select client_name from projects where id='${PID}'`);
ok('TC4 クライアント名 保存 → DB 突合', dbClient === '監査クライアント株式会社', `db=${dbClient}`);
await page.reload({ waitUntil: 'networkidle' });
await page.getByLabel(/プロジェクト名/).waitFor({ timeout: 30000 });
ok('TC5 リロード後もクライアント名永続', (await page.getByLabel(/クライアント名/).inputValue()) === '監査クライアント株式会社');

// TC6: 種別変更 → 保存 → DB (project_type=internal_product) → 戻す
await page.getByLabel(/種別/).selectOption('self_product');
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1500);
const dbType = sql(`select project_type from projects where id='${PID}'`);
ok('TC6 種別変更 保存 → DB enum マッピング', dbType === 'internal_product', `db=${dbType}`);
await page.getByLabel(/種別/).selectOption('client_project');
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1200);

// TC7: ステータス draft のまま保存しても draft が保たれる (旧実装は active へ化けた)
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1200);
const dbStatus = sql(`select status from projects where id='${PID}'`);
ok('TC7 draft のまま保存 → DB draft 維持 (化けない)', dbStatus === 'draft', `db=${dbStatus}`);

// TC8: AI 学習トグル — 初期 OFF (DB optout=true) → ON → DB false → リロードで ON 永続 → OFF へ戻す
const toggle = page.getByLabel('AI 学習への利用を許可');
const toggleLabel = page.locator('label:has(input[aria-label="AI 学習への利用を許可"])');
ok('TC8 トグル初期値 = DB 実値 (OFF)', !(await toggle.isChecked()));
await toggleLabel.click();
await page.waitForTimeout(1200);
const dbOpt = sql(`select ai_training_optout from projects where id='${PID}'`);
ok('TC9 トグル ON → DB ai_training_optout=false', dbOpt === 'f', `db=${dbOpt}`);
await page.reload({ waitUntil: 'networkidle' });
await page.getByLabel(/プロジェクト名/).waitFor({ timeout: 30000 });
await page.waitForTimeout(600);
ok('TC10 リロード後トグル ON 永続 (旧実装は常に OFF 表示)', await page.getByLabel('AI 学習への利用を許可').isChecked());
await page.locator('label:has(input[aria-label="AI 学習への利用を許可"])').click();
await page.waitForTimeout(1000);

// TC11: エクスポート ヒアリング → outputs あり + html_path あり + storage 未設定 → 503 明示
await page.getByRole('button', { name: 'ヒアリング' }).click();
await page.locator('p[role="status"]').waitFor({ timeout: 15000 });
const msg1 = (await page.locator('p[role="status"]').textContent()) || '';
ok('TC11 エクスポート: storage 未設定を明示 (503)', msg1.includes('storage が未設定'), msg1);

// TC12: エクスポート 要件定義 → outputs 0 件 → 「まだありません」
await page.getByRole('button', { name: '要件定義' }).click();
await page.waitForTimeout(1200);
const msg2 = (await page.locator('p[role="status"]').textContent()) || '';
ok('TC12 エクスポート: 0 件工程は「まだありません」', msg2.includes('まだありません'), msg2);

// TC13: 削除 2 段階 — 確認 UI → キャンセル → DELETE 発火なし
await page.getByRole('button', { name: 'プロジェクトを削除' }).click();
ok('TC13 削除 1 クリック目は確認表示のみ', await page.locator('text=本当に削除しますか？').isVisible());
await page.getByRole('button', { name: 'キャンセル' }).click();
const dbDeleted = sql(`select deleted_at is null from projects where id='${PID}'`);
ok('TC14 キャンセル → DB 未削除', dbDeleted === 't', `not_deleted=${dbDeleted}`);

// TC15: 招待管理を開く → /client/s_l01 へ遷移
await page.getByRole('link', { name: /招待管理を開く/ }).click();
await page.waitForTimeout(1500);
ok('TC15 招待管理リンク → 招待管理画面 (project 文脈保持)', page.url().includes('/portal/invitations') && page.url().includes(`project=${PID}`), page.url());
await page.goBack({ waitUntil: 'networkidle' });

// レスポンシブ: 768 / 390 (フルページ、390 は目視監査用)
for (const [w, tag] of [[768, 'tablet-768'], [390, 'mobile-390']]) {
  const c2 = await browser.newContext({ viewport: { width: w, height: 900 } });
  await c2.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p2 = await c2.newPage();
  await p2.goto(`http://localhost:3100/projects/settings?project=${PID}`, {
    waitUntil: 'networkidle',
  });
  await p2.getByLabel(/プロジェクト名/).waitFor({ timeout: 30000 });
  await p2.waitForTimeout(600);
  if (w === 390) {
    // モバイルで主要操作が可能なことを実操作で確認
    const hasHScroll = await p2.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    );
    ok('TC16 390px 横スクロールなし', !hasHScroll);
    await p2.getByRole('button', { name: 'ヒアリング' }).click();
    await p2.locator('p[role="status"]').waitFor({ timeout: 15000 });
    ok('TC17 390px でエクスポート操作可能', true);
  }
  await p2.screenshot({ path: `${SCRATCH}/shots/S-B03-${tag}.png`, fullPage: true });
  await c2.close();
}

await browser.close();
// 後片付け: client_name を元 (null) へ戻す
sql(`update projects set client_name=null where id='${PID}'`);

let fail = 0;
for (const [s, n, e] of R) {
  if (s === 'FAIL') fail++;
  console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`);
}
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
