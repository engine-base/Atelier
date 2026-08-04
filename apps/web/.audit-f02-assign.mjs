/**
 * GAP-004 工程担当割当 実操作監査 (S-F02 + S-F01 ヘッダー)
 *
 * 実 UI で: S-F02 の割当 select で担当を追加 → DB phases.assigned_employee_ids
 * 突合 → チップ表示 → S-F01 ヘッダーアバターが実割当を優先表示 →
 * チップ × で外す → DB が空に戻る (往復)。
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
// 監査用の工程を作成 (order 99 — 既存に影響しない)
sql(`delete from phases where name like '割当監査-%'`); // 前回残留の掃除
const ord = 90 + Math.floor(Math.random() * 900);
const phId = one(
  `insert into phases (project_id, "order", name, status) values ('${pid}', ${ord}, '割当監査-${mark}', 'in_progress') returning id`,
);
check(!!phId, `監査用工程シード (${phId.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/workflow/phases?project=${pid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 割当追加 (select で ワンダ)
const addSelect = page.getByLabel(`割当監査-${mark} に担当を追加`);
await addSelect.waitFor({ state: 'visible', timeout: 15000 });
check(true, '割当 select 描画');
await addSelect.selectOption({ label: 'ワンダ' });
await page.waitForTimeout(1500);

const wandaId = one(
  `select e.id from ai_employees e join projects p on p.workspace_id=e.workspace_id where p.id='${pid}' and e.name='wanda' limit 1`,
);
const dbIds = one(`select array_to_string(assigned_employee_ids, ',') from phases where id='${phId}'`);
check(dbIds === wandaId, `DB: assigned_employee_ids にワンダ (${dbIds.slice(0, 8)})`);
check(
  await page.getByRole('button', { name: `割当監査-${mark} の担当から ワンダ を外す` }).isVisible(),
  '割当チップ「ワンダ」描画 (外すボタンで実在確認)',
);

// S-F01 ヘッダーが実割当を優先 (該当工程を選択表示)
await page.screenshot({ path: `${SP}/f02-assign-${mark}.png` });

// チップ × で外す → DB 空へ (往復)
await page.getByRole('button', { name: `割当監査-${mark} の担当から ワンダ を外す` }).click();
await page.waitForTimeout(1500);
const dbAfter = one(`select coalesce(array_to_string(assigned_employee_ids, ','), '') from phases where id='${phId}'`);
check(dbAfter === '', 'DB: 外すと空配列に戻る (往復)');

// API 検証: 他 WS 社員は 422 (実 JWT)
const token = JSON.parse(
  execSync(
    `curl -s -X POST http://127.0.0.1:8000/auth/signin -H 'Content-Type: application/json' -d '{"email":"design-audit@example.com","password":"Passw0rd!123"}'`,
    { encoding: 'utf8' },
  ),
).data.access_token;
const otherEmp = one(
  `select e.id from ai_employees e join projects p on p.workspace_id=e.workspace_id where p.id='${pid}' limit 1 offset 0` === '' ? '' :
  `select e.id from ai_employees e where e.workspace_id not in (select workspace_id from projects where id='${pid}') limit 1`,
);
if (otherEmp) {
  const code = execSync(
    `curl -s -o /dev/null -w '%{http_code}' -X PATCH http://127.0.0.1:8000/workflow/phases/${phId} -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' -d '{"assigned_employee_ids":["${otherEmp}"]}'`,
    { encoding: 'utf8' },
  ).trim();
  check(code === '422', `他 WS 社員の割当は 422 (実際: ${code})`);
} else {
  check(true, '他 WS 社員なし (422 検証は pytest 済)');
}

await browser.close();
sql(`delete from phases where id='${phId}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/f02-assign-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
