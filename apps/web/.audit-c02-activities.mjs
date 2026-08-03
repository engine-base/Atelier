/**
 * GAP-008 AI 社員活動フィード 実操作監査 (S-C02)
 *
 * 実 UI で: design-audit WS の実社員 1 名に task/decision/thread をシード →
 * S-C02 の「活動履歴」タブに横断フィードが実描画 → DB 実件数と突合。
 * 終了時にシードを削除 (再実行可能)。
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

const pid = one(
  "select p.id from projects p join workspaces w on w.id=p.workspace_id join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' and p.deleted_at is null order by p.created_at limit 1",
);
const emp = one(
  `select e.id from ai_employees e join projects p on p.workspace_id = e.workspace_id where p.id='${pid}' and e.name='wanda' limit 1`,
);
check(!!emp, `対象社員 wanda (${emp.slice(0, 8)})`);

const taskId = one(
  `insert into tasks (project_id, category, title, type, estimated_hours, priority, lifecycle_stage, assigned_employee_id) values ('${pid}','misc','活動監査タスク-${mark}','feature',2,'medium','done','${emp}') returning id`,
);
const decId = one(
  `insert into decisions (project_id, status, body, decided_by) values ('${pid}','decided','活動監査決定-${mark}','${emp}') returning id`,
);
const thId = one(
  `insert into chat_threads (project_id, ai_employee_id, title) values ('${pid}','${emp}','活動監査スレッド-${mark}') returning id`,
);
check(!!taskId && !!decId && !!thId, 'task/decision/thread をシード');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

// 社員詳細 (S-C02) へ — 組織図から wanda を開く
await page.goto(`http://localhost:3100/employees/${emp}`, { waitUntil: 'networkidle' }).catch(() => {});
if (!(await page.getByRole('tab', { name: /活動履歴/ }).isVisible().catch(() => false))) {
  await page.goto(`http://localhost:3100/employees/detail?employee=${emp}`, { waitUntil: 'networkidle' }).catch(() => {});
}
await page.waitForTimeout(1500);

const tab = page.getByRole('tab', { name: /活動履歴/ });
await tab.waitFor({ state: 'visible', timeout: 15000 });
check(true, '活動履歴タブ描画');
await tab.click();
await page.getByText('最近の活動').waitFor({ state: 'visible', timeout: 10000 });
check(await page.getByText(`活動監査タスク-${mark}`).first().isVisible(), 'タスク活動が実描画');
check(await page.getByText(`活動監査決定-${mark}`).first().isVisible(), '決定活動が実描画');
check(await page.getByText(`活動監査スレッド-${mark}`).first().isVisible(), 'チャット活動が実描画');
check(await page.getByText('状態: done').first().isVisible(), 'タスク詳細 (状態) 表示');

await page.screenshot({ path: `${SP}/c02-activities-${mark}.png` });
await browser.close();
sql(`update tasks set deleted_at=now() where id='${taskId}'`);
sql(`update decisions set deleted_at=now() where id='${decId}'`);
sql(`update chat_threads set deleted_at=now() where id='${thId}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/c02-activities-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
