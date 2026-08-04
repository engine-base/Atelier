/**
 * GAP-031②③ 実操作監査 (S-F01 工程直接操作 + S-I03 並び替え)
 *
 * S-F01: 新規プロジェクト → 工程 seed → 「この工程を完了として承認」(承認のみ、
 * DB: completed) → 開始が enabled 化 → 「次工程（X）を開始」(DB: in_progress) →
 * 前工程に成果物をシード → 「前工程の成果物を見る」→ 成果物タブに実表示。
 * S-I03: 判断待ち(新)+進行中(旧) をシード → 並び替え「新しい順」で結合グリッドの
 * 先頭が新しいタスク → 「進捗順」見出し切替。終了時にシード削除 (再実行可能)。
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

const wsId = one(
  "select w.id from workspaces w join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' order by w.created_at limit 1",
);
const proj = one(`insert into projects (workspace_id,name,project_type) values ('${wsId}','直接操作監査-${mark}','internal_product') returning id`);
check(!!proj, `プロジェクトシード (${proj.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

// ── S-F01: 工程 seed → 承認/開始の分離操作 ────────────────────────────
await page.goto(`http://localhost:3100/workflow?project=${proj}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: '工程を開始する' }).click();
await page.waitForTimeout(2000);

const approveBtn = page.getByRole('button', { name: 'この工程を完了として承認' });
await approveBtn.waitFor({ state: 'visible', timeout: 15000 });
check(true, '「この工程を完了として承認」描画 (進行中工程あり)');
const startBtnBefore = page.getByRole('button', { name: /次工程（.+）を開始/ });
check(await startBtnBefore.isDisabled(), '進行中がある間「次工程を開始」は disabled (二重進行防止)');

const p1 = one(`select id from phases where project_id='${proj}' and status='in_progress' order by "order" limit 1`);
await approveBtn.click();
await page.waitForTimeout(1800);
check(one(`select status from phases where id='${p1}'`) === 'completed', 'DB: 承認で completed のみ (次工程は自動開始しない)');
check(one(`select count(*) from phases where project_id='${proj}' and status='in_progress'`) === '0', 'DB: 進行中 0 (承認直後)');

const startBtn = page.getByRole('button', { name: /次工程（.+）を開始/ });
await startBtn.waitFor({ state: 'visible', timeout: 15000 });
check(!(await startBtn.isDisabled()), '承認後「次工程を開始」が enabled 化');
await startBtn.click();
await page.waitForTimeout(1800);
const p2 = one(`select id from phases where project_id='${proj}' and status='in_progress' order by "order" limit 1`);
check(!!p2 && p2 !== p1, `DB: 次工程が in_progress (${p2.slice(0, 8)})`);

// 前工程 (p1) に成果物をシード → 「前工程の成果物を見る」で成果物タブに実表示
sql(`insert into workflow_outputs (project_id, phase_id, stage, version, summary) values ('${proj}','${p1}','hearing',1,'前工程成果物-${mark}')`);
await page.reload({ waitUntil: 'networkidle' });
const prevBtn = page.getByRole('button', { name: '前工程の成果物を見る' });
await prevBtn.waitFor({ state: 'visible', timeout: 15000 });
await prevBtn.click();
await page.waitForTimeout(1200);
check(
  (await page.getByText(`前工程成果物-${mark}`).count()) > 0,
  '「前工程の成果物を見る」→ 前工程選択 + 成果物タブに実表示',
);
await page.screenshot({ path: `${SP}/f01-ops-${mark}.png` });

// ── S-I03: 並び替え (要対応が上 / 新しい順 / 進捗順) ──────────────────
sql(`insert into tasks (project_id,title,type,category,estimated_hours,lifecycle_stage,updated_at) values ('${proj}','ソート監査-旧-${mark}','feature','backend',1,'in_progress', now() - interval '2 days')`);
sql(`insert into tasks (project_id,title,type,category,estimated_hours,lifecycle_stage,updated_at) values ('${proj}','ソート監査-新-${mark}','feature','backend',1,'awaiting', now())`);
await page.goto(`http://localhost:3100/tasks/monitor?project=${proj}`, { waitUntil: 'networkidle' });

const attentionSort = page.getByRole('button', { name: '要対応が上' });
await attentionSort.waitFor({ state: 'visible', timeout: 15000 });
check((await attentionSort.getAttribute('aria-pressed')) === 'true', '既定 = 要対応が上 (区分表示)');
check((await page.getByText('順調に進行中').count()) > 0, '区分見出し (順調に進行中) 描画');

await page.getByRole('button', { name: '新しい順' }).click();
await page.waitForTimeout(600);
check((await page.getByText('すべてのセッション（新しい順）').count()) > 0, '新しい順: 結合グリッド見出し');
const cardTitles = await page
  .locator('.grid >> text=/ソート監査-(新|旧)-/')
  .allInnerTexts();
check(
  cardTitles.length === 2 && cardTitles[0].includes(`ソート監査-新-${mark}`),
  `新しい順: updated_at 降順 (先頭=${(cardTitles[0] ?? '').slice(0, 14)}…)`,
);

await page.getByRole('button', { name: '進捗順' }).click();
await page.waitForTimeout(600);
check((await page.getByText('すべてのセッション（進捗順）').count()) > 0, '進捗順: 結合グリッド見出し');
await page.screenshot({ path: `${SP}/i03-sort-${mark}.png` });

await browser.close();
sql(`delete from projects where id='${proj}'`); // phases/tasks/outputs は cascade
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/f01-ops-${mark}.png, ${SP}/i03-sort-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
