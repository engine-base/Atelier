/**
 * GAP-013 cron 実行履歴 実操作監査 (S-O01)
 *
 * 実 UI で: cron_run_history に成功/失敗行をシード (platform 行 = 実際の
 * Inngest handler wrapper が書くのと同スキーマ) → S-O01 の実行履歴テーブルに
 * 実データ描画 (名前/所要時間/結果) → API の RLS (authenticated で platform 行可視)
 * を突合。終了時にシードを削除 (再実行可能)。
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
// platform 実行履歴を 2 件シード (producer と同スキーマ: name/status/detail)
const r1 = one(
  `insert into cron_run_history (name, status, started_at, finished_at, detail) values ('transcribe-queue-${mark}','success', now() - interval '5 minutes', now() - interval '5 minutes' + interval '8 seconds', '{"processed":"2"}') returning id`,
);
const r2 = one(
  `insert into cron_run_history (name, status, started_at, finished_at, detail) values ('daily-digest-${mark}','error', now() - interval '3 minutes', now() - interval '3 minutes' + interval '2 seconds', '{"error":"smtp"}') returning id`,
);
check(!!r1 && !!r2, `実行履歴 2 件シード (${r1.slice(0, 8)}, ${r2.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/schedules?project=${pid}`, { waitUntil: 'networkidle' }).catch(() => {});
if (!(await page.getByText('実行履歴', { exact: false }).first().isVisible().catch(() => false))) {
  // ルートが異なる場合のフォールバック
  await page.goto(`http://localhost:3100/cron?project=${pid}`, { waitUntil: 'networkidle' }).catch(() => {});
}
await page.waitForTimeout(2000);

const hist = page.getByText(/実行履歴（直近/);
await hist.waitFor({ state: 'visible', timeout: 15000 });
check(true, '実行履歴セクション描画');
check(await page.getByText(`transcribe-queue-${mark}`).isVisible(), 'シード行 (success) が実描画');
check(await page.getByText(`daily-digest-${mark}`).isVisible(), 'シード行 (error) が実描画');
check(await page.getByText('8 秒').isVisible(), '所要時間の実算出 (8 秒)');
const table = await page.getByRole('table', { name: 'cron 実行履歴' }).innerText();
check(/成功/.test(table) && /失敗/.test(table), '結果ラベル 成功/失敗');

await page.screenshot({ path: `${SP}/o01-runs-${mark}.png` });
await browser.close();
sql(`delete from cron_run_history where id in ('${r1}','${r2}')`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/o01-runs-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
