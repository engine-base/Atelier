/**
 * GAP-014 法令・運用バックエンド 実操作監査 (S-O01)
 *
 * 1. シード: 退会 31 日経過ユーザー (+所有 WS) / dangling dependency タスク
 *    (design-audit WS の新規プロジェクト)
 * 2. 実ジョブ実行: python -m src.services.platform_jobs {purge|integrity}
 *    (cron handler と同一本体 + record_run で cron_run_history 記録)
 * 3. DB 突合: 退会ユーザー物理削除 (auth+public+WS) / 猶予中・現役ユーザー無傷 /
 *    approval_inbox integrity_alert (design-audit 宛) / cron_run_history success
 * 4. S-O01 実描画: 法令・運用バックエンド節 (2 ジョブ・無効化不可・最終実行 成功)
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
const runJob = (job) =>
  execSync(`cd /home/user/Atelier/apps/api && ATELIER_DB_URL='postgresql+asyncpg://atelier_dev:devpass@localhost:5432/atelier_dev' /home/user/Atelier/.venv/bin/python -m src.services.platform_jobs ${job}`, {
    encoding: 'utf8',
  }).trim();

const mark = Math.random().toString(36).slice(2, 7);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

// --- シード ---------------------------------------------------------------
// 退会 31 日経過 (purge 対象) + 5 日経過 (猶予中 — 絶対に消えてはならない)
const uDue = one(`insert into auth.users (id,email) values (gen_random_uuid(),'purge-due-${mark}@t.invalid') returning id`);
sql(`insert into public.users (id,email,deleted_at) values ('${uDue}','purge-due-${mark}@t.invalid', now() - interval '31 days')`);
const wsDue = one(`insert into public.workspaces (owner_user_id,name) values ('${uDue}','purge-ws-${mark}') returning id`);
const uGrace = one(`insert into auth.users (id,email) values (gen_random_uuid(),'purge-grace-${mark}@t.invalid') returning id`);
sql(`insert into public.users (id,email,deleted_at) values ('${uGrace}','purge-grace-${mark}@t.invalid', now() - interval '5 days')`);

// design-audit WS に整合性違反タスク (dangling dependency)
const auditUid = one("select u.id from users u where u.email='design-audit@example.com'");
const wsId = one(`select id from workspaces where owner_user_id='${auditUid}' order by created_at limit 1`);
const proj = one(`insert into projects (workspace_id,name,project_type) values ('${wsId}','整合性監査-${mark}','internal_product') returning id`);
sql(`insert into tasks (project_id,title,type,category,estimated_hours,dependencies) values ('${proj}','dangling-${mark}','feature','backend',1, array[gen_random_uuid()])`);
check(!!uDue && !!wsDue && !!proj, `シード完了 (purge 対象 ${uDue.slice(0, 8)} / 違反 project ${proj.slice(0, 8)})`);

// --- 実ジョブ実行 (cron と同一本体 + cron_run_history 記録) ---------------
const purgeOut = runJob('purge');
check(purgeOut.includes("'status': 'ok'"), `purge 実行 (${purgeOut.slice(0, 80)})`);
const integOut = runJob('integrity');
check(integOut.includes("'status': 'ok'"), `integrity 実行 (${integOut.slice(0, 80)})`);

// --- DB 突合 ---------------------------------------------------------------
check(one(`select count(*) from public.users where id='${uDue}'`) === '0', 'DB: 31 日経過ユーザーは物理削除');
check(one(`select count(*) from auth.users where id='${uDue}'`) === '0', 'DB: auth 側も削除');
check(one(`select count(*) from workspaces where id='${wsDue}'`) === '0', 'DB: 所有 workspace も削除');
check(one(`select count(*) from public.users where id='${uGrace}'`) === '1', 'DB: 猶予中 (5 日) ユーザーは無傷');
check(one(`select count(*) from public.users where id='${auditUid}'`) === '1', 'DB: 現役ユーザーは無傷');
check(
  one(`select count(*) from audit_logs where action='platform.account.purged' and target_id='${uDue}'`) === '1',
  'DB: 削除実行の監査証跡 (platform.account.purged)',
);
const alertRow = one(
  `select user_id||'|'||status from approval_inbox where type='integrity_alert' and target_id='${proj}'`,
);
check(alertRow === `${auditUid}|pending`, `DB: integrity_alert が WS owner の承認待ちへ (${alertRow})`);
check(
  one("select status from cron_run_history where name='purge-deleted-accounts' order by started_at desc limit 1") === 'success' &&
  one("select status from cron_run_history where name='integrity-check' order by started_at desc limit 1") === 'success',
  'DB: cron_run_history に両ジョブ success 記録',
);

// --- S-O01 実描画 ----------------------------------------------------------
const pid = one(`select id from projects where workspace_id='${wsId}' and deleted_at is null and name not like '整合性監査-%' order by created_at limit 1`);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/schedules?project=${pid}`, { waitUntil: 'networkidle' });

const section = page.getByRole('region', { name: '法令・運用バックエンド' });
await section.waitFor({ state: 'visible', timeout: 15000 });
const text = await section.innerText();
check(text.includes('退会データを 30 日後に完全削除'), '退会データ削除ジョブ描画');
check(text.includes('データ整合性チェック'), '整合性チェックジョブ描画');
check(text.includes('無効化不可'), '「無効化不可」タグ描画 (法令対応)');
check(text.includes('0 15 * * *') && text.includes('0 20 * * *'), '実 cron 式描画 (UTC)');
check((text.match(/最終実行 成功/g) ?? []).length === 2, '両ジョブの最終実行 成功 (実 cron_run_history)');
await page.screenshot({ path: `${SP}/o01-legal-${mark}.png`, fullPage: true });

await browser.close();
// --- シード削除 (approval → project cascade → 猶予ユーザー) ---------------
sql(`delete from approval_inbox where target_id='${proj}'`);
sql(`delete from projects where id='${proj}'`);
sql(`delete from public.users where id='${uGrace}'`);
sql(`delete from auth.users where id='${uGrace}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/o01-legal-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
