/**
 * T-UC-36〜40 (通知/プロフィール/WS切替/プロジェクト切替/横断検索) — design-audit 実操作検証
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-tuc36-40.mjs
 *
 * ユーティリティ 5 画面 (モック HTML 無し・仕様書ベース) を一括検証:
 *   36 通知: TopBar ベル (未読バッジ実数) → 通知センター → 既読 → 承認への実リンク
 *   37 プロフィール: TopBar アバター → 表示名変更 → DB 突合 → TopBar 反映
 *   38/39 切替: 一覧実データ + 選択の localStorage 永続
 *   40 検索: TopBar 検索 → 実データ横断ヒット
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const UID = '252e66c4-1504-4fd3-b008-2b8af3e3024c';
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);
const vis = (loc, t = 10000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
const mark = Math.random().toString(36).slice(2, 7);

// ── 通知ソースの承認待ちを 2 件投入 (自分宛・実テーブル) ──
sql(`insert into approval_inbox (user_id, type, target_type, target_id, title) values ('${UID}', 'task_approval', 'task', gen_random_uuid(), '監査通知A ${mark}'), ('${UID}', 'knowledge_write', 'knowledge_node', gen_random_uuid(), '監査通知B ${mark}')`);
// 検索ヒット用タスク
const api = async (method, path, body) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const sTask = await api('POST', '/tasks', { project_id: PID, category: '監査', title: `検索対象タスク ${mark}`, type: 'feature', estimated_hours: 2, priority: 'low' });
ok('TC1 監査データ投入 (承認待ち2 + 検索対象タスク)', sql(`select count(*) from approval_inbox where title like '監査通知%${mark}'`) === '2' && sTask.status === 201);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// ── TopBar 導線 (到達性是正): ベル (未読バッジ) / 検索 / アバター ──
await page.goto(`http://localhost:3100/projects?project=${PID}`, { waitUntil: 'networkidle' });
const bell = page.getByRole('link', { name: /通知センター/ });
ok('TC2 TopBar ベルに実未読数バッジ', await vis(bell) && /承認待ち [1-9][0-9]* 件/.test((await bell.getAttribute('aria-label')) ?? ''));
ok('TC3 TopBar に検索/プロフィールの実リンク', (await page.getByRole('link', { name: '検索' }).count()) === 1 && (await page.getByRole('link', { name: /プロフィール:/ }).count()) === 1);

// ── T-UC-36 通知センター ──
await bell.click();
await page.waitForURL((u) => u.pathname === '/t-uc-36', { timeout: 15000 });
ok('TC4 通知センターに実データ 2 件', await vis(page.getByText(`監査通知A ${mark}`)) && await vis(page.getByText(`監査通知B ${mark}`)));
const unreadBefore = await page.getByText(/未読 \d+/).textContent();
await page.getByRole('button', { name: `監査通知A ${mark} を既読にする` }).click();
const unreadAfter = await page.getByText(/未読 \d+/).textContent();
ok('TC5 既読で未読数が減る (localStorage 永続)', Number((unreadBefore ?? '').replace(/\D/g, '')) - 1 === Number((unreadAfter ?? '').replace(/\D/g, '')));
await page.getByRole('tab', { name: '未読のみ' }).click();
ok('TC6 未読のみフィルタで既読が消える', (await page.getByText(`監査通知A ${mark}`).count()) === 0 && await vis(page.getByText(`監査通知B ${mark}`)));
ok('TC7 通知→承認インボックスへの実リンク', (await page.locator('a[href="/approvals"]').count()) >= 1);
await page.screenshot({ path: `${SCRATCH}/shots/TUC36-desktop-1440.png`, fullPage: true });
// リロードで既読が維持される (F5 永続)
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('tab', { name: '未読のみ' }).click();
ok('TC8 リロード後も既読が維持', (await page.getByText(`監査通知A ${mark}`).count()) === 0);

// ── T-UC-37 プロフィール ──
await page.getByRole('link', { name: /プロフィール:/ }).click();
await page.waitForURL((u) => u.pathname === '/t-uc-37', { timeout: 15000 });
const newName = `監査ユーザー ${mark}`;
const nameInput = page.getByLabel(/表示名/);
await nameInput.waitFor({ state: 'visible', timeout: 15000 });
await nameInput.fill(newName);
await page.getByRole('button', { name: /保存/ }).click();
await page.waitForTimeout(1500);
ok('TC9 表示名変更 → DB 突合', sql(`select display_name from users where id='${UID}'`) === newName);
await page.screenshot({ path: `${SCRATCH}/shots/TUC37-desktop-1440.png`, fullPage: true });

// ── T-UC-38 WS 切替 (listbox 実操作。既存値による偽陽性を避けるため事前クリア) ──
await page.goto('http://localhost:3100/t-uc-38', { waitUntil: 'networkidle' });
await page.evaluate(() => window.localStorage.removeItem('atelier_current_workspace'));
await page.reload({ waitUntil: 'networkidle' });
const wsBtn = page.getByRole('button', { name: /Design Audit WS|ワークスペース/ }).first();
ok('TC10 WS ピッカーが実データ', await vis(wsBtn));
await wsBtn.click();
await page.getByRole('option', { name: /Design Audit WS/ }).click();
const wsSaved = await page.evaluate(() => window.localStorage.getItem('atelier_current_workspace'));
ok('TC11 WS 選択が localStorage 永続 (実操作)', wsSaved === '9498aa8b-08cb-4cb0-9656-f31961db8496', String(wsSaved));

// ── T-UC-39 プロジェクト切替 (listbox 実操作) ──
await page.goto('http://localhost:3100/t-uc-39', { waitUntil: 'networkidle' });
await page.evaluate(() => window.localStorage.removeItem('atelier_current_project'));
await page.reload({ waitUntil: 'networkidle' });
const pjBtn = page.getByRole('button', { name: /プロジェクト/ }).first();
ok('TC12 プロジェクトピッカーが実データ', await vis(pjBtn) && await vis(page.getByText('ECサイトリニューアル').first()));
await pjBtn.click();
await page.getByRole('option', { name: /ECサイトリニューアル/ }).click();
const pjSaved = await page.evaluate(() => window.localStorage.getItem('atelier_current_project'));
ok('TC13 プロジェクト選択が localStorage 永続 (実操作)', pjSaved === PID, String(pjSaved));

// ── T-UC-40 横断検索 ──
await page.goto('http://localhost:3100/t-uc-40', { waitUntil: 'networkidle' });
const q = page.getByRole('searchbox').or(page.getByPlaceholder(/検索/)).first();
await q.waitFor({ state: 'visible', timeout: 15000 });
await q.fill(`検索対象タスク ${mark}`);
ok('TC14 横断検索が実データにヒット', await vis(page.getByText(`検索対象タスク ${mark}`).nth(0), 15000) && await vis(page.getByText(/task|タスク/).first()));
await page.screenshot({ path: `${SCRATCH}/shots/TUC40-desktop-1440.png`, fullPage: true });
await ctx.close();

// ── 390px (5 画面すべて横スクロールなし) ──
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
let mobileOk = true;
for (const path of ['/t-uc-36', '/t-uc-37', '/t-uc-38', '/t-uc-39', '/t-uc-40']) {
  await p3.goto(`http://localhost:3100${path}`, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(1200);
  const h = await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
  if (h) { mobileOk = false; console.log(`  h-scroll at ${path}`); }
  await p3.screenshot({ path: `${SCRATCH}/shots/TUC${path.replace('/t-uc-', '')}-mobile-390.png`, fullPage: true });
}
ok('TC15 390px 全 5 画面 横スクロールなし', mobileOk);
await m.close();
await browser.close();

// ── 後片付け ──
sql(`delete from approval_inbox where title like '監査通知%${mark}'`);
await api('DELETE', `/tasks/${sTask.json?.data?.id}`);
ok('TC16 自作データ削除', sql(`select count(*) from approval_inbox where title like '監査通知%${mark}'`) === '0');

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
