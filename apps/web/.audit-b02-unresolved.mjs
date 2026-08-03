/**
 * GAP-005 未解決コメント KPI 実操作監査 (S-B02)
 *
 * 実 UI で: 対象プロジェクトに open コメントをシード → ダッシュボードの
 * 「未解決コメント」KPI が実カウントを表示 → コメント解決 → リロードで減算。
 * DB 突合 + 3 連続用に再実行可能 (自作コメントは終了時に削除)。
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const mark = Math.random().toString(36).slice(2, 7);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

const pid = sql(
  "select p.id from projects p join workspaces w on w.id=p.workspace_id join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' and p.deleted_at is null order by p.created_at limit 1",
);
// open コメントを 2 件シード (workflow_output 経由 — 無ければ作る)
let outId = sql(`select id from workflow_outputs where project_id='${pid}' order by created_at limit 1`).split('\n')[0].trim();
if (!outId) {
  outId = sql(`insert into workflow_outputs (project_id, stage, summary) values ('${pid}','design','監査用') returning id`).split('\n')[0].trim();
}
const c1 = sql(`insert into comments (target_type,target_id,content,status) values ('workflow_output','${outId}','未解決監査-${mark}-1','open') returning id`).split('\n')[0].trim();
const c2 = sql(`insert into comments (target_type,target_id,content,status) values ('workflow_output','${outId}','未解決監査-${mark}-2','open') returning id`).split('\n')[0].trim();
check(!!c1 && !!c2, `open コメント 2 件シード (${c1.slice(0, 8)}, ${c2.slice(0, 8)})`);
const dbCount = Number(sql(`select count(*) from comments c where c.deleted_at is null and c.status='open' and c.target_type='workflow_output' and exists (select 1 from workflow_outputs t where t.id=c.target_id and t.project_id='${pid}')`));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/projects/dashboard?project=${pid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// KPI カード「未解決コメント」が DB 実カウントと一致
const kpiLabel = page.getByText('未解決コメント', { exact: true });
await kpiLabel.waitFor({ state: 'visible', timeout: 15000 });
check(true, 'KPI「未解決コメント」描画');
const kpiSection = page.getByRole('region', { name: 'KPI 一覧' });
const cardText = (await kpiSection.innerText().catch(() => '')).replaceAll('\n', ' ');
const kpiRe = new RegExp(`未解決コメント\\s*${dbCount}`);
check(kpiRe.test(cardText), `KPI 値が DB 実カウント一致 (${dbCount}) — 表示: ${cardText.slice(cardText.indexOf('未解決'), cardText.indexOf('未解決') + 30)}`);

// 1 件解決 → リロードで減算
sql(`update comments set status='resolved' where id='${c1}'`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const after = dbCount - 1;
const cardText2 = ((await page.getByRole('region', { name: 'KPI 一覧' }).innerText().catch(() => '')) ?? '').replaceAll('\n', ' ');
const kpiRe2 = new RegExp(`未解決コメント\\s*${after}`);
check(kpiRe2.test(cardText2), `解決で減算 (${dbCount}→${after}) — 表示: ${cardText2.slice(cardText2.indexOf('未解決'), cardText2.indexOf('未解決') + 30)}`);

await page.screenshot({ path: `${SP}/b02-unresolved-${mark}.png` });
await browser.close();
sql(`delete from comments where id in ('${c1}','${c2}')`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/b02-unresolved-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
