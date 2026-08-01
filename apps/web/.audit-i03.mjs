/**
 * S-I03 実行モニター — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-i03.mjs
 *
 * 使い捨てタスク 4 種 (awaiting / blocked / in_progress / queued) を API で作成し
 * (dispatch_status 等 write API の無い列のみ SQL)、フリートビューの分類・統計・
 * カード上の承認/再試行 (DB 突合)・SSE ライブログ・390px を検証する。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const WS = '9498aa8b-08cb-4cb0-9656-f31961db8496';
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
const vis = (loc, t = 10000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
const mark = Math.random().toString(36).slice(2, 7);

const mk = async (title, est = 3) => {
  const r = await api('POST', '/tasks', {
    project_id: PID, category: '監査', title, type: 'screen', estimated_hours: est, priority: 'high',
  });
  return r.json?.data?.id;
};

// ── 使い捨てデータ: 4 区分のタスク + 実行履歴 ──
const tAwait = await mk(`監査 承認待ちタスク ${mark}`);
const tBlock = await mk(`監査 要対応タスク ${mark}`);
const tRun = await mk(`監査 実装中タスク ${mark}`);
const tQueue = await mk(`監査 順番待ちタスク ${mark}`, 12);
ok('TC1 タスク 4 件作成', [tAwait, tBlock, tRun, tQueue].every(Boolean));

const visionId = sql(`select id from ai_employees where workspace_id='${WS}' and name='vision'`);
const thorId = sql(`select id from ai_employees where workspace_id='${WS}' and name='thor'`);
await api('PATCH', `/tasks/${tAwait}`, { lifecycle_stage: 'awaiting' });
await api('PATCH', `/tasks/${tBlock}`, { lifecycle_stage: 'blocked', blocked_reason: '条件 6 が未達' });
await api('PATCH', `/tasks/${tRun}`, { lifecycle_stage: 'in_progress' });
sql(`update tasks set assigned_employee_id='${visionId}' where id='${tAwait}'`);
sql(`update tasks set assigned_employee_id='${thorId}', retry_count=1 where id='${tBlock}'`);
sql(`update tasks set assigned_employee_id='${thorId}', dispatch_status='running' where id='${tRun}'`);
sql(`update tasks set dispatch_status='queued' where id='${tQueue}'`);
sql(`insert into task_executions (task_id, status, score, ac_pass_rate, started_at) values ('${tAwait}', 'succeeded', 0.87, 0.92, now())`);
const execId = sql(`select id from task_executions where task_id='${tAwait}' limit 1`);
ok('TC2 区分/実行履歴の投入', !!execId);

// ── UI: モック基準ショット ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/task/S-I03-monitor.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-I03-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();

// 到達性: かんばんツールバー → 実行モニター
await page.goto(`http://localhost:3100/tasks?project=${PID}`, { waitUntil: 'networkidle' });
ok('TC3 かんばんに「実行モニター」導線', await vis(page.getByRole('link', { name: '実行モニター' })));
await page.getByRole('link', { name: '実行モニター' }).click();
await page.waitForURL((u) => u.pathname === '/tasks/monitor', { timeout: 15000 });

// フリートビュー: 分類 + 統計
ok('TC4 要対応セクションに awaiting/blocked カード', await vis(page.getByText(`監査 承認待ちタスク ${mark}`)) && await vis(page.getByText(`監査 要対応タスク ${mark}`)));
ok('TC5 統計「承認 1 件・再試行 1 件」', await vis(page.getByText('承認 1 件・再試行 1 件')));
ok('TC6 実行スコアバー (0.87 / 0.95)', await vis(page.getByText('0.87 / 0.95（自動承認しきい値）').first()));
ok('TC7 blocked_reason 表示', await vis(page.getByText('条件 6 が未達').first()));
ok('TC8 担当が表示名 (ヴィジョン/ソー)', await vis(page.getByText('ヴィジョン').first()) && await vis(page.getByText('ソー').first()));
ok('TC9 進行中カード + dispatch 日本語ラベル', await vis(page.getByText(`監査 実装中タスク ${mark}`)) && await vis(page.getByText('実装中 · 実行中').first()));
ok('TC10 順番待ちリスト (見積 12 時間)', await vis(page.getByText(`監査 順番待ちタスク ${mark}`)) && await vis(page.getByText('見積 12 時間')));
ok('TC11 SSE ログへの実リンク', (await page.locator(`a[href="/tasks/monitor?execution=${execId}"]`).count()) >= 1);
ok('TC12 裏付けの無い 停止/一時停止 ボタン非描画 (Rule 10)', (await page.getByRole('button', { name: /停止/ }).count()) === 0);
await page.screenshot({ path: `${SCRATCH}/shots/S-I03-desktop-1440.png`, fullPage: true });

// カード上の承認 (2 段階) → DB 突合
await page.getByRole('button', { name: '承認', exact: true }).click();
await page.getByRole('button', { name: '確定' }).click();
await page.waitForTimeout(1500);
ok('TC13 カード承認 → DB: done + audit_logs', sql(`select lifecycle_stage from tasks where id='${tAwait}'`) === 'done' && sql(`select count(*) from audit_logs where action='task.approve' and target_id='${tAwait}'`) === '1');

// カード上の再試行 → DB 突合 (blocked → ready, retry_count 2)
await page.getByRole('button', { name: '再試行', exact: true }).click();
await page.getByRole('button', { name: '確定' }).click();
await page.waitForTimeout(1500);
ok('TC14 カード再試行 → DB: ready + retry_count=2', sql(`select lifecycle_stage || '|' || retry_count from tasks where id='${tBlock}'`) === 'ready|2');

// SSE ライブログ (?execution=)
await page.goto(`http://localhost:3100/tasks/monitor?execution=${execId}`, { waitUntil: 'networkidle' });
ok('TC15 SSE ライブログが実イベントを受信', await vis(page.getByText('状態: succeeded').first(), 20000));
ok('TC16 ライブログに role=log (aria-live)', (await page.locator('[role="log"]').count()) === 1);
await page.screenshot({ path: `${SCRATCH}/shots/S-I03-sse-1440.png`, fullPage: true });
await ctx.close();

// ── 390px ──
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto(`http://localhost:3100/tasks/monitor?project=${PID}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(2500);
const hasHScroll = await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('TC17 390px 横スクロールなし', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-I03-mobile-390.png`, fullPage: true });
await m.close();
await browser.close();

// ── 後片付け ──
sql(`delete from task_executions where task_id='${tAwait}'`);
for (const id of [tAwait, tBlock, tRun, tQueue]) await api('DELETE', `/tasks/${id}`);
ok('TC18 自作データ削除', sql(`select count(*) from tasks where id in ('${tAwait}','${tBlock}','${tRun}','${tQueue}') and deleted_at is null`) === '0');

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
