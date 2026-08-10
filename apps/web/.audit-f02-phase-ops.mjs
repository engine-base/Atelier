/**
 * GAP-022 実操作監査 (S-F02 AI 提案フェーズ + F-IMP01 影響範囲解析 + phase 別集計)
 *
 * 検証: ① phase 別タスク集計行 (実 done/total/awaiting/スコア平均) ② 統計
 * (F-IMP01 実行回数/依存整合性チェック 実データ) ③ ジャービスへの提案依頼 (明示
 * 操作) → pending カード (提案理由トグル) → 却下 = フェーズ不変 / 再提案 → 承認 =
 * 実 phases 行確定 (DB 突合) ④ F-IMP01: タスク+移動先選択 → 実解析 (依存の推移的
 * 走査) → 承認して移動 = 実移動 + 完了済影響のリファクタ自動起票 (F-CUC02)
 * ⑤ dangling 依存で整合性 NG。専用プロジェクトをシードし終了時に削除 (再実行可能)。
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

// 前回残留掃除 (専用プロジェクトごと削除 — cascades)
sql("delete from projects where name like 'F02監査-%'");

const uid = one("select id from users where email='design-audit@example.com'");
const ws = one(`select id from workspaces where owner_user_id='${uid}' order by created_at limit 1`);

// シード: 専用プロジェクト + フェーズ 2 + タスク M←B(done)←C + 承認待ち W
const proj = one(
  `insert into projects (workspace_id, name, project_type) values ('${ws}','F02監査-${mark}','internal_product') returning id`,
);
const ph1 = one(`insert into phases (project_id, "order", name) values ('${proj}',1,'実装') returning id`);
const ph2 = one(`insert into phases (project_id, "order", name) values ('${proj}',2,'検証') returning id`);
const tM = one(
  `insert into tasks (project_id, phase_id, category, title, type, estimated_hours, lifecycle_stage) values ('${proj}','${ph1}','misc','移動対象M-${mark}','feature',2,'in_progress') returning id`,
);
const tB = one(
  `insert into tasks (project_id, phase_id, category, title, type, estimated_hours, lifecycle_stage, dependencies) values ('${proj}','${ph1}','misc','影響B-${mark}','feature',2,'done', array['${tM}']::uuid[]) returning id`,
);
const tC = one(
  `insert into tasks (project_id, phase_id, category, title, type, estimated_hours, lifecycle_stage, dependencies) values ('${proj}','${ph1}','misc','影響C-${mark}','feature',2,'triage', array['${tB}']::uuid[]) returning id`,
);
sql(
  `insert into tasks (project_id, phase_id, category, title, type, estimated_hours, lifecycle_stage) values ('${proj}','${ph1}','misc','承認待ちW-${mark}','feature',1,'awaiting')`,
);
sql(
  `insert into task_executions (task_id, started_at, completed_at, status, score) values ('${tB}', now() - interval '2 hours', now() - interval '1 hour', 'succeeded', 0.9)`,
);
check(!!proj && !!tC, `シード完了 (project ${proj.slice(0, 8)} / M←B(done)←C + W)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

await page.goto(`http://localhost:3100/workflow/phases?project=${proj}`, { waitUntil: 'networkidle' });
await page.getByText('実装', { exact: true }).first().waitFor({ state: 'visible', timeout: 20000 });

// ① phase 別集計行 (実装: 4 タスク中 done 1 / awaiting 1 / スコア平均 0.90)
check((await page.getByText('/ 4 タスク完了').count()) > 0, '① 集計行 1 / 4 タスク完了 (実集計)');
check((await page.getByText('スコア平均 0.90').count()) > 0, '① スコア平均 0.90 (実 task_executions)');

// ② 統計 (初期: 実行回数 0 / 整合性 OK)
check((await page.getByText('0 回（本日）').count()) > 0, '② F-IMP01 実行回数 0 回（本日）');
check((await page.getByText('依存整合性チェック').count()) > 0 && (await page.getByText('OK', { exact: true }).count()) > 0, '② 依存整合性チェック OK');

// ③ ジャービスへの提案依頼 → pending カード
await page.getByRole('button', { name: 'ジャービスに次フェーズを提案してもらう' }).click();
await page.getByText(/（AI提案）/).waitFor({ state: 'visible', timeout: 20000 });
const prop1 = one(`select id from phase_proposals where project_id='${proj}' and status='pending'`);
check(!!prop1, '③ 提案が DB に pending 実在 (明示操作起点)');
check((await page.getByText(/ジャービスが提案 ·/).count()) > 0, '③ ジャービスが提案 表示');
await page.getByRole('button', { name: '提案理由を見る' }).click();
check((await page.getByText(/\[fake LLM\] 既存フェーズ構成/).count()) > 0, '③ 提案理由トグル表示 (実 reason)');
await page.screenshot({ path: `${SP}/f02-${mark}-proposal.png` });

// ③a 却下 → フェーズ不変
const phasesBefore = one(`select count(*) from phases where project_id='${proj}'`);
await page.getByRole('button', { name: '却下', exact: true }).click();
await page.getByText('提案を却下しました（フェーズは作成されません）。').waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select status from phase_proposals where id='${prop1}'`) === 'rejected' &&
    one(`select count(*) from phases where project_id='${proj}'`) === phasesBefore,
  '③ 却下 → rejected + フェーズ数不変',
);

// ③b 再提案 → 承認 = 実フェーズ確定
await page.getByRole('button', { name: 'ジャービスに次フェーズを提案してもらう' }).click();
await page.getByText(/（AI提案）/).waitFor({ state: 'visible', timeout: 20000 });
await page.getByRole('button', { name: '承認', exact: true }).click();
await page.getByText(/提案を承認し、第 3 段階/).waitFor({ state: 'visible', timeout: 15000 });
const newPhase = one(`select id from phases where project_id='${proj}' and "order"=3`);
check(!!newPhase, '③ 承認 → 実 phases 行 (order 3) が DB 実在');
check(
  one(`select approved_phase_id from phase_proposals where project_id='${proj}' and status='approved'`) === newPhase,
  '③ approved_phase_id 突合',
);
await page.getByText('第 3 段階', { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 });

// ④ F-IMP01: 解析 → 適用
await page.getByLabel('影響解析の対象タスク').selectOption(tM);
await page.getByLabel('移動先フェーズ').selectOption(ph2);
await page.getByRole('button', { name: '影響を解析' }).click();
await page.getByText(/2 タスクへの影響を検出（実装済み 1 \/ その他 1）/).waitFor({ state: 'visible', timeout: 20000 });
check((await page.getByText(`影響B-${mark}`).count()) > 0 && (await page.getByText(`影響C-${mark}`).count()) > 0, '④ 影響ノード実描画 (依存の推移的走査 B, C)');
check((await page.getByText('リファクタタスクとして自動起票').count()) > 0, '④ F-CUC02 注記表示 (完了済 1 件)');
const ana = one(`select id from impact_analyses where project_id='${proj}' order by created_at desc limit 1`);
check(!!ana, '④ 解析が impact_analyses に記録');
await page.getByText('1 回（本日）').waitFor({ state: 'visible', timeout: 15000 });
check(true, '② 実行回数が 1 回（本日）に実更新');
await page.screenshot({ path: `${SP}/f02-${mark}-impact.png` });

await page.getByRole('button', { name: '承認して移動' }).click();
await page.getByText('タスクを移動し、リファクタタスク 1 件を自動起票しました（F-CUC02）。').waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select phase_id from tasks where id='${tM}'`) === ph2,
  '④ 適用 → M が 検証 フェーズへ実移動 (DB 突合)',
);
const refactor = one(
  `select id from tasks where project_id='${proj}' and origin_type='refactor' and title like 'リファクタ: 影響B-%'`,
);
check(!!refactor, '④ 完了済 B のリファクタタスク自動起票 (origin_type=refactor)');
check(
  one(`select lifecycle_stage || '|' || category from tasks where id='${refactor}'`) === 'triage|リファクタ',
  '④ リファクタタスクは triage / カテゴリ リファクタ',
);
check((await page.getByText('適用済み', { exact: true }).count()) > 0, '④ 適用済み表示');
await page.screenshot({ path: `${SP}/f02-${mark}-applied.png` });

// ⑤ dangling 依存 → 整合性 NG
sql(
  `insert into tasks (project_id, phase_id, category, title, type, estimated_hours, dependencies) values ('${proj}','${ph1}','misc','宙ぶらりんD-${mark}','feature',1, array['00000000-0000-4000-8000-000000000000']::uuid[])`,
);
await page.reload({ waitUntil: 'networkidle' });
await page.getByText('不整合 1 件').waitFor({ state: 'visible', timeout: 20000 });
check(true, '⑤ dangling 依存で 依存整合性チェック 不整合 1 件 (実計算)');

// audit 突合
check(
  one(
    `select count(*) from audit_logs where action in ('phase.proposal.propose','phase.proposal.reject','phase.proposal.approve') and target_id in ('${proj}','${newPhase}')`,
  ) === '4',
  'audit 提案 4 行 (propose×2 / reject / approve)',
);
check(
  one(`select count(*) from audit_logs where action in ('task.impact.analyze','task.impact.apply') and target_id='${tM}'`) === '2',
  'audit F-IMP01 2 行 (analyze / apply)',
);

await browser.close();
sql(`delete from projects where id='${proj}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/f02-${mark}-*.png)`);
process.exit(failures === 0 ? 0 : 1);
