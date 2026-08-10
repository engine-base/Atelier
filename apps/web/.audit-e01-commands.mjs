/**
 * GAP-002 実操作監査 (S-E01 /コマンド)
 *
 * 検証: /コマンド パレット実描画 → /決定 挿入 → 送信でサーバー実行
 * (実 decisions 行 + user/system メッセージ永続を DB 突合) → /タスク化 で
 * 実 tasks 行 (triage) → 未対応コマンドは誠実 inline error。
 * 終了時にシード削除 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const one = (q) => sql(q).split('\n')[0].trim();

const mark = Math.random().toString(36).slice(2, 7);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

// 前回残留掃除
sql("delete from chat_messages where thread_id in (select id from chat_threads where title like 'コマンド監査-%')");
sql("delete from chat_threads where title like 'コマンド監査-%'");
sql("delete from decisions where body like 'コマンド監査決定-%'");
sql("delete from tasks where title like 'コマンド監査タスク-%'");

const uid = one("select id from users where email='design-audit@example.com'");
const pid = one(
  `select p.id from projects p join workspaces w on w.id=p.workspace_id where w.owner_user_id='${uid}' and p.deleted_at is null order by p.created_at limit 1`,
);
const emp = one(
  `select e.id from ai_employees e join projects p on p.workspace_id=e.workspace_id where p.id='${pid}' limit 1`,
);
const tid = one(
  `insert into chat_threads (project_id, ai_employee_id, title) values ('${pid}','${emp}','コマンド監査-${mark}') returning id`,
);
check(!!tid, `シード完了 (thread ${tid.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/chat?thread=${tid}`, { waitUntil: 'networkidle' });

// パレット実描画 → /決定 挿入
await page.getByRole('button', { name: '/コマンド' }).waitFor({ state: 'visible', timeout: 20000 });
await page.getByRole('button', { name: '/コマンド' }).click();
check(
  (await page.getByRole('option').count()) === 3 &&
    (await page.getByText('内容を確定事項 (decisions) として記録します').count()) > 0,
  '/コマンド パレット実描画 (3 コマンド + 説明)',
);
await page.getByRole('option', { name: /\/決定 <内容>/ }).click();
const input = page.getByLabel('メッセージを入力');
check((await input.inputValue()) === '/決定 ', 'パレット選択で「/決定 」挿入');

// /決定 実行 → decisions 行 + user/system メッセージ
const decBody = `コマンド監査決定-${mark}: 配色は secondary を正とする`;
await input.fill(`/決定 ${decBody}`);
await page.getByRole('button', { name: '送信' }).click();
await page.getByText(`コマンド /決定: 「${decBody}」を確定事項として記録しました`).waitFor({ state: 'visible', timeout: 20000 });
check(true, 'system メッセージ実描画 (実行結果)');
check(
  one(`select count(*) || '|' || max((with_user)::text) from decisions where body='${decBody.replaceAll("'", "''")}'`) === '1|true',
  'DB: 実 decisions 行 (with_user=true)',
);
check(
  one(`select string_agg(role::text, ',' order by created_at, id) from chat_messages where thread_id='${tid}'`) === 'user,system',
  'DB: コマンド原文 (user) + 結果 (system) の順で永続',
);

// /タスク化 実行 → tasks 行 (triage)
const taskTitle = `コマンド監査タスク-${mark}`;
await input.fill(`/タスク化 ${taskTitle}`);
await page.getByRole('button', { name: '送信' }).click();
await page.getByText(`コマンド /タスク化: タスク「${taskTitle}」を起票しました (triage)`).waitFor({ state: 'visible', timeout: 20000 });
check(
  one(`select category || '|' || lifecycle_stage from tasks where title='${taskTitle}'`) === 'チャット起票|triage',
  'DB: 実 tasks 行 (チャット起票 / triage)',
);
check(
  one(`select count(*) from audit_logs where action='chat_command.executed' and target_id='${tid}'`) === '2',
  'DB: audit chat_command.executed ×2',
);
await page.screenshot({ path: `${SP}/e01-commands-${mark}.png` });

// 未対応コマンドは誠実 inline error (何も実行しない)
await input.fill('/デプロイ 本番');
await page.getByRole('button', { name: '送信' }).click();
check(
  (await page.getByText(/未対応のコマンドです: \/デプロイ/).count()) > 0,
  '未対応コマンドは inline error',
);
check(
  one(`select count(*) from chat_messages where thread_id='${tid}'`) === '4',
  'DB: 未対応コマンドは何も永続しない (4 件のまま)',
);

await browser.close();
sql(`delete from decisions where body='${decBody.replaceAll("'", "''")}'`);
sql(`delete from tasks where title='${taskTitle}'`);
sql(`delete from chat_messages where thread_id='${tid}'`);
sql(`delete from chat_threads where id='${tid}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/e01-commands-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
