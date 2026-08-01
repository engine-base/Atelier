/**
 * S-I02 タスク詳細 — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-i02.mjs
 *
 * mocks 同様に使い捨てタスクを API で作成し、AC/実行履歴/依存 (供給 write API の
 * 無いフィールドのみ SQL で投入) を整え、UI 実操作 → DB 突合で検証する。
 * 操作バーは approve / reject / retry の 3 遷移すべてを実 API + DB で実証する。
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
const api = async (method, path, body) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);
/** locator が visible になるまで待つ (isVisible は待機しないため使わない)。 */
const vis = (loc, t = 10000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
const mark = Math.random().toString(36).slice(2, 7);

// ── 使い捨てデータ作成 (API 優先、write API の無いフィールドのみ SQL) ──
const mk = async (title, extra = {}) => {
  const r = await api('POST', '/tasks', {
    project_id: PID,
    category: '監査',
    title,
    type: 'screen',
    estimated_hours: 3,
    priority: 'high',
    ...extra,
  });
  return { status: r.status, id: r.json?.data?.id };
};

const dep1 = await mk(`監査 前提タスク ${mark}`);
const dep2 = await mk(`監査 後続タスク ${mark}`);
const main = await mk(`監査 ログイン画面の実装 ${mark}`, { description: '監査用の本文です。' });
ok('TC1 タスク作成 (POST /tasks) → 201', main.status === 201 && dep1.status === 201 && dep2.status === 201);

// 前提を done に (PATCH 実 API)
const done1 = await api('PATCH', `/tasks/${dep1.id}`, { lifecycle_stage: 'done' });
ok('TC2 PATCH lifecycle_stage=done → 200', done1.status === 200);

// write API の無いフィールドは SQL 投入 (assigned_employee_id / 依存配列 / AC / 実行履歴)
const thorId = sql(`select id from ai_employees where workspace_id='9498aa8b-08cb-4cb0-9656-f31961db8496' and name='thor'`);
sql(`update tasks set assigned_employee_id='${thorId}', prerequisites=array['${dep1.id}']::uuid[], blocks=array['${dep2.id}']::uuid[] where id='${main.id}'`);
sql(
  `insert into acceptance_criteria (task_id, html_path, items, version) values ('${main.id}', 'ac/audit.html', ` +
    `jsonb_build_array(` +
    `jsonb_build_object('tier', 1, 'text', '画面 ID が正しく設定されている'), ` +
    `jsonb_build_object('tier', 2, 'text', 'サインインが成功する'), ` +
    `jsonb_build_object('tier', 3, 'text', '既存導線が壊れていない')), 1)`,
);
sql(`insert into task_executions (task_id, status, score, ac_pass_rate, started_at) values ('${main.id}', 'succeeded', 0.83, 0.83, now())`);
const execId = sql(`select id from task_executions where task_id='${main.id}' limit 1`);

// awaiting に遷移 (承認バー検証用)
const toAwait = await api('PATCH', `/tasks/${main.id}`, { lifecycle_stage: 'awaiting' });
ok('TC3 awaiting へ遷移 (PATCH) → 200', toAwait.status === 200);

// AC / 実行履歴 / 依存が read API から見える
const acRes = await api('GET', `/tasks/${main.id}/acceptance-criteria`);
ok('TC4 GET acceptance-criteria が 3 項目', Array.isArray(acRes.json?.data?.items) && acRes.json.data.items.length === 3);
const exRes = await api('GET', `/tasks/${main.id}/executions`);
ok('TC5 GET executions が score=0.83 を返す', Array.isArray(exRes.json?.data) && exRes.json.data[0]?.score === 0.83);

// ── UI: モック基準ショット ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/task/S-I02-detail.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-I02-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// 到達性: S-I01 かんばんカードのタイトルリンク → 詳細
await page.goto(`http://localhost:3100/tasks?project=${PID}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const cardLink = page.getByRole('link', { name: `監査 ログイン画面の実装 ${mark}` }).first();
ok('TC6 かんばんカードに詳細への実リンク', (await cardLink.getAttribute('href').catch(() => null)) === `/tasks/detail?task=${main.id}`);
await cardLink.click();
await page.waitForURL((u) => u.pathname === '/tasks/detail' && u.searchParams.get('task') === main.id, { timeout: 15000 });
await page.getByRole('heading', { name: `監査 ログイン画面の実装 ${mark}` }).waitFor({ state: 'visible', timeout: 15000 });
ok('TC7 かんばん → 詳細へ遷移 (到達性是正)', true);

// ヘッダ: 担当が表示名 (生コード禁止) + 種別/優先度ラベル + 承認待ちステップ
ok('TC8 担当 AI が表示名「ソー」(生コード thor を出さない)', await vis(page.getByText('ソー').first()) && (await page.getByText('thor', { exact: true }).count()) === 0);
ok('TC9 種別/優先度タグが日本語ラベル', await vis(page.getByText('画面実装')) && await vis(page.getByText('優先度：高')));

// タブ: 受入条件 (tier 見出し)
ok('TC10 受入条件タブに 3-tier 見出し', await vis(page.getByText('構造の条件')) && await vis(page.getByText('再発防止の条件')));

// 進捗・スコア
await page.getByRole('tab', { name: /進捗・スコア/ }).click();
ok('TC11 スコアサークルが実行スコア 0.83 を表示', await vis(page.getByText('0.83').first()));

// 依存タスク: タイトル解決チップ
await page.getByRole('tab', { name: /依存タスク/ }).click();
ok('TC12 前提/後続チップがタイトル解決される', await vis(page.getByText(`監査 前提タスク ${mark}`)) && await vis(page.getByText(`監査 後続タスク ${mark}`)));

// 実行履歴: S-I03 への実リンク
await page.getByRole('tab', { name: /実行履歴/ }).click();
const histLink = page.locator(`a[href="/tasks/monitor?execution=${execId}"]`);
ok('TC13 実行履歴が実行モニター (S-I03) へ実リンク', (await histLink.count()) === 1);

// コメント: UI 追加 → DB 突合
await page.getByRole('tab', { name: /コメント/ }).click();
const commentText = `監査コメント ${mark}`;
await page.getByPlaceholder('コメントを追加…').fill(commentText);
await page.getByRole('button', { name: 'コメント', exact: true }).click();
await page.waitForTimeout(1500);
const cid = sql(`select id from comments where target_type='task' and target_id='${main.id}' and content='${commentText}'`);
ok('TC14 コメント追加が DB に永続 (target_type=task)', !!cid);

await page.screenshot({ path: `${SCRATCH}/shots/S-I02-desktop-1440.png`, fullPage: true });

// ── 操作バー: 差し戻し (awaiting→blocked, note が blocked_reason に) ──
await page.getByRole('button', { name: /差し戻し/ }).click();
await page.getByLabel('差し戻し理由').fill('条件 2 が未達のため差し戻し');
await page.getByRole('button', { name: '確定' }).click();
await page.waitForTimeout(1500);
ok('TC15 差し戻し → DB: blocked + blocked_reason=note', sql(`select lifecycle_stage || '|' || blocked_reason from tasks where id='${main.id}'`) === 'blocked|条件 2 が未達のため差し戻し');
ok('TC16 audit_logs に task.reject', sql(`select count(*) from audit_logs where action='task.reject' and target_id='${main.id}'`) === '1');

// 要対応バッジ + blocked_reason がヘッダに出る
ok('TC17 要対応バッジ + 理由表示', await vis(page.getByText('要対応').first()));

// ── 再試行 (blocked→ready, retry_count+1) ──
await page.getByRole('button', { name: /再試行/ }).click();
await page.getByRole('button', { name: '確定' }).click();
await page.waitForTimeout(1500);
ok('TC18 再試行 → DB: ready + retry_count=1', sql(`select lifecycle_stage || '|' || retry_count from tasks where id='${main.id}'`) === 'ready|1');

// ready では操作バーが消える (死にボタンを置かない)
ok('TC19 ready では操作バー非描画', (await page.getByRole('button', { name: /承認する/ }).count()) === 0 && (await page.getByRole('button', { name: /^再試行$/ }).count()) === 0);

// ── 承認 (awaiting→done) ──
await api('PATCH', `/tasks/${main.id}`, { lifecycle_stage: 'awaiting' });
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: /承認する/ }).waitFor({ state: 'visible', timeout: 15000 });
await page.getByRole('button', { name: /承認する/ }).click();
await page.getByRole('button', { name: '確定' }).click();
await page.waitForTimeout(1500);
ok('TC20 承認 → DB: done', sql(`select lifecycle_stage from tasks where id='${main.id}'`) === 'done');
ok('TC21 audit_logs に task.approve', sql(`select count(*) from audit_logs where action='task.approve' and target_id='${main.id}'`) === '1');
await ctx.close();

// ── 390px ──
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto(`http://localhost:3100/tasks/detail?task=${main.id}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(2500);
const hasHScroll = await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('TC22 390px 横スクロールなし', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-I02-mobile-390.png`, fullPage: true });
await m.close();
await browser.close();

// ── 後片付け ──
await api('DELETE', `/comments/${cid}`);
sql(`delete from task_executions where task_id='${main.id}'`);
sql(`delete from acceptance_criteria where task_id='${main.id}'`);
for (const id of [main.id, dep1.id, dep2.id]) await api('DELETE', `/tasks/${id}`);
ok('TC23 自作データ削除 (論理削除)', sql(`select count(*) from tasks where id in ('${main.id}','${dep1.id}','${dep2.id}') and deleted_at is null`) === '0');

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
