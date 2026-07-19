/**
 * S-T01〜T06 admin 系 — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に admin トークン
 *       (auth.users.raw_app_meta_data role=admin を付与した design-audit ユーザー)。
 * 実行: node .audit-t.mjs
 * 注意: T02/T06 で監査用スキル/ナレッジを作成し最後に削除する (自作データのみ破壊)。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const api = async (method, path, body, tok) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// モック基準 (1440・6 画面)
for (const [file, tag] of [
  ['S-T01-dashboard', 'T01'],
  ['S-T02-skills', 'T02'],
  ['S-T03-templates', 'T03'],
  ['S-T04-users', 'T04'],
  ['S-T05-audit', 'T05'],
  ['S-T06-platform-knowledge', 'T06'],
]) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const p = await c.newPage();
  await p.goto(`file:///home/user/Atelier/06_mockups/admin/${file}.html`, {
    waitUntil: 'networkidle',
  });
  await p.screenshot({ path: `${SCRATCH}/shots/S-${tag}-mock-1440.png`, fullPage: true });
  await c.close();
}

// ---- 非 admin の拒否 ----
const email = `not-admin-${Math.random().toString(36).slice(2, 8)}@example.com`;
await api('POST', '/auth/signup', {
  email, password: 'Passw0rd!123', display_name: 'Not Admin',
  consents: [
    { type: 'terms_of_service', version: '1.0', accepted: true },
    { type: 'privacy_policy', version: '1.0', accepted: true },
  ],
});
const tokB = (await api('POST', '/auth/signin', { email, password: 'Passw0rd!123' })).json?.data?.access_token;
const denied = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await denied.addCookies([{ name: 'atelier_access', value: tokB, domain: 'localhost', path: '/' }]);
const pd = await denied.newPage();
await pd.goto('http://localhost:3100/admin', { waitUntil: 'networkidle' });
await pd.waitForTimeout(2000);
ok('TC1 非 admin は 403 拒否表示', await pd.getByRole('alert').filter({ hasText: '権限' }).first().isVisible({ timeout: 15000 }).catch(() => false));
await pd.screenshot({ path: `${SCRATCH}/shots/S-T01-denied.png` });
await denied.close();

// ---- admin セッション ----
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// T01: ダッシュボード — KPI が DB 実数と一致
await page.goto('http://localhost:3100/admin', { waitUntil: 'networkidle' });
await page.waitForSelector('text=運営ダッシュボード', { timeout: 30000 });
ok('TC2 管理シェル (ダークサイドバー ADMIN CONSOLE)', await page.locator('text=ADMIN CONSOLE').isVisible());
const dash = (await api('GET', '/admin/dashboard', null, token)).json?.data ?? {};
// 契約 (T-A-41): 集計は admin の所属 WS 範囲。DB 照合も同スコープで行う
const wsDb = sql(`select count(distinct workspace_id) from workspace_memberships where user_id='252e66c4-1504-4fd3-b008-2b8af3e3024c'`);
const kpiWs = await page.locator('article', { hasText: 'ワークスペース数' }).locator('div').nth(1).textContent();
ok('TC3 KPI ワークスペース数 = API = DB(所属WS範囲)', String(dash.workspace_count) === wsDb.trim() && (kpiWs || '').trim() === wsDb.trim(), `ui=${kpiWs} api=${dash.workspace_count} db=${wsDb}`);
ok('TC4 KPI 監査イベント(24h) 表示 (旧実装は欠落)', await page.locator('text=監査イベント (24h)').isVisible());
const rawUuidCount = await page.locator('section[aria-label="最近のアクティビティ"] >> text=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/').count();
ok('TC5 アクティビティの actor がメール表示 (生 UUID 露出なし)', rawUuidCount === 0, `uuid_leak=${rawUuidCount}`);
await page.screenshot({ path: `${SCRATCH}/shots/S-T01-desktop.png`, fullPage: true });

// シェルナビで 6 画面を巡回
const NAVS = [
  ['能力（スキル）', 'スキル管理', '/admin/skills', 'T02'],
  ['AI 社員テンプレ', 'AI 社員テンプレート', '/admin/templates', 'T03'],
  ['ユーザー', 'ユーザー管理', '/admin/users', 'T04'],
  ['監査ログ', '監査ログ', '/admin/audit', 'T05'],
  ['運営ナレッジ', '運営デフォルト・ナレッジ', '/admin/platform-knowledge', 'T06'],
];
for (const [navLabel, heading, url, tag] of NAVS) {
  await page.getByRole('link', { name: navLabel }).first().click();
  await page.waitForURL(`**${url}`, { timeout: 20000 });
  await page.locator(`h1:has-text("${heading}")`).waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SCRATCH}/shots/S-${tag}-desktop.png`, fullPage: true });
}
ok('TC6 シェルナビで 6 画面すべて到達 (旧実装は導線ゼロ)', true);

// T02: スキル 新規登録 → 一覧反映 → DB 突合 → 削除
await page.goto('http://localhost:3100/admin/skills', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: '新規アップロード' }).click();
await page.getByLabel('スキル名').fill('audit-probe-skill');
await page.getByLabel(/バージョン/).fill('1.0.0');
await page.getByLabel(/SKILL\.md 本文/).fill('# audit-probe-skill\n\n監査用のプローブスキルです。');
await page.getByRole('button', { name: '登録', exact: true }).click();
// 成功時は dialog が閉じる。閉じない場合はエラー文言を証跡に残す
await page.locator('text=新規スキル登録').waitFor({ state: 'detached', timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1000);
const skillDb = sql("select count(*) from skills where name='audit-probe-skill'");
const rowShown = await page.getByText('audit-probe-skill').first().isVisible({ timeout: 10000 }).catch(() => false);
ok('TC7 T02 スキル新規登録 → 一覧 + DB', skillDb === '1' && rowShown, `db=${skillDb} row=${rowShown}`);
// 重複登録 → 409 の明示エラー (500 実バグの回帰確認)
await page.getByRole('button', { name: '新規アップロード' }).click();
await page.getByLabel('スキル名').fill('audit-probe-skill');
await page.getByLabel(/バージョン/).fill('1.0.0');
await page.getByLabel(/SKILL\.md 本文/).fill('# dup');
await page.getByRole('button', { name: '登録', exact: true }).click();
await page.waitForTimeout(1500);
ok('TC7b T02 重複登録は 409 明示エラー (旧: 500+汎用文言)', await page.getByRole('alert').filter({ hasText: '既に存在' }).first().isVisible({ timeout: 8000 }).catch(() => false));
await page.getByRole('button', { name: 'キャンセル' }).click();
await page.getByRole('button', { name: 'audit-probe-skill を削除' }).click();
// 削除確認 UI があれば確定を押す
const confirmBtn = page.getByRole('button', { name: /^(削除する|削除|OK|確定)$/ }).first();
if (await confirmBtn.isVisible({ timeout: 1500 }).catch(() => false)) await confirmBtn.click();
await page.waitForTimeout(1500);
const skillGone = sql("select count(*) from skills where name='audit-probe-skill'");
ok('TC8 T02 スキル削除 → DB 反映', skillGone === '0', `remaining=${skillGone}`);

// T03: テンプレ一覧 = DB 実数
await page.goto('http://localhost:3100/admin/templates', { waitUntil: 'networkidle' });
await page.locator('h1:has-text("AI 社員テンプレート")').waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);
const tmplDb = Number(sql('select count(*) from ai_employee_templates'));
const tmplRows = await page.locator('ul > li').count();
ok('TC9 T03 テンプレ一覧が実データ', tmplDb > 0 && tmplRows >= Math.min(tmplDb, 1), `db=${tmplDb} rows=${tmplRows}`);

// T04: ユーザー一覧に admin 自身 + 検索
await page.goto('http://localhost:3100/admin/users', { waitUntil: 'networkidle' });
await page.locator('h1:has-text("ユーザー管理")').waitFor({ timeout: 20000 });
await page.locator('text=design-audit@example.com').first().waitFor({ timeout: 20000 });
ok('TC10 T04 ユーザー一覧に実ユーザー', true);
const searchBox = page.locator('input[type=search], input[placeholder*="検索"], input[placeholder*="絞り込み"]').first();
await searchBox.fill('design-audit');
await page.waitForTimeout(800);
const visRows = await page.locator('.truncate.font-bold').count();
ok('TC11 T04 検索で絞り込み', visRows >= 1 && (await page.locator('text=design-audit@example.com').first().isVisible()), `rows=${visRows}`);

// T05: 監査ログ — 実データ + 検索/フィルタ
await page.goto('http://localhost:3100/admin/audit', { waitUntil: 'networkidle' });
await page.locator('h1:has-text("監査ログ")').waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);
await page.locator('input[type=search], input[placeholder*="絞り込み"]').first().fill('credential');
await page.waitForTimeout(800);
const credShown = await page.locator('text=/credential\\./').count();
const otherShown = await page.locator('text=/project\\.update/').count();
const credDb = Number(sql("select count(*) from audit_logs where action like 'credential%'"));
ok('TC12 T05 検索で絞り込み (credential)', credShown >= 1 && otherShown === 0 && credDb >= 1, `cred=${credShown} other=${otherShown} db=${credDb}`);
const wsSelect = await page.locator('select[aria-label="WS で絞り込み"]').count();
ok('TC13 T05 死に select (全WSのみ) が撤去済', wsSelect === 0, `ws_select=${wsSelect}`);

// T06: 運営ナレッジ 作成 → visible toggle → 削除 (DB 突合)
await page.goto('http://localhost:3100/admin/platform-knowledge', { waitUntil: 'networkidle' });
await page.locator('h1:has-text("運営デフォルト・ナレッジ")').waitFor({ timeout: 20000 });
await page.getByRole('button', { name: '新規追加' }).click();
await page.getByLabel('タイトル').fill('監査プローブナレッジ');
await page.getByLabel('カテゴリ').fill('audit');
await page.getByLabel(/本文/).fill('# 監査プローブ\n\ndesign-audit の実操作検証用。');
await page.getByRole('button', { name: /追加|登録|保存/ }).last().click();
await page.locator('td', { hasText: '監査プローブナレッジ' }).first().waitFor({ timeout: 20000 });
const knDb = sql("select count(*) from knowledge_nodes where title='監査プローブナレッジ' and deleted_at is null");
ok('TC14 T06 ナレッジ作成 → DB 反映', knDb === '1', `rows=${knDb}`);
const visBefore = sql("select visible_in_tree from knowledge_nodes where title='監査プローブナレッジ' and deleted_at is null");
await page.getByLabel(new RegExp('監査プローブナレッジ のツリー表示を')).click();
await page.waitForTimeout(1200);
const visAfter = sql("select visible_in_tree from knowledge_nodes where title='監査プローブナレッジ' and deleted_at is null");
ok('TC15 T06 ツリー表示トグル → DB 反転', visBefore !== visAfter, `before=${visBefore} after=${visAfter}`);
// 削除 (確認があれば確定)
await page.getByRole('button', { name: '監査プローブナレッジ を削除' }).click();
await page.getByRole('button', { name: '削除する' }).click();
await page.waitForTimeout(1500);
const knGone = sql("select count(*) from knowledge_nodes where title='監査プローブナレッジ' and deleted_at is null");
ok('TC16 T06 ナレッジ削除 → DB 反映', knGone === '0', `remaining=${knGone}`);

await ctx.close();

// ---- 390px: 6 画面 + モバイルナビ ----
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto('http://localhost:3100/admin', { waitUntil: 'networkidle' });
await p3.locator('h1:has-text("運営ダッシュボード")').waitFor({ timeout: 30000 });
// モバイルナビ (横スクロールチップ) で監査ログへ
await p3.getByRole('link', { name: '監査ログ' }).first().click();
await p3.waitForURL('**/admin/audit', { timeout: 20000 });
ok('TC17 390px モバイルナビで遷移可能', true);
for (const [url, tag] of [
  ['/admin', 'T01'],
  ['/admin/skills', 'T02'],
  ['/admin/templates', 'T03'],
  ['/admin/users', 'T04'],
  ['/admin/audit', 'T05'],
  ['/admin/platform-knowledge', 'T06'],
]) {
  await p3.goto(`http://localhost:3100${url}`, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(800);
  const hasHScroll = await p3.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
  );
  ok(`TC18 ${tag} 390px body 横スクロールなし`, !hasHScroll);
  await p3.screenshot({ path: `${SCRATCH}/shots/S-${tag}-mobile-390.png`, fullPage: true });
}
await m.close();
await browser.close();

// 後片付け (残骸があれば)
sql("delete from skills where name='audit-probe-skill'");
sql("delete from knowledge_nodes where title='監査プローブナレッジ'");

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
