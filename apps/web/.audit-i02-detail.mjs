/**
 * GAP-025 実操作監査 (S-I02 タスク詳細の未描画要素群)
 *
 * 検証: ① 仕様変更 3 択カード (実検知 = mock v2 シード) → adopt で mock_id 差替
 * (DB 突合) + 再表示なし / 別タスクで split → 実フォロータスク起票 ② テスト結果
 * タブ (task_execution_tests 実 rows) ③ 関連資料タブ (mock/spec/branch/knowledge
 * 実リンク) ④ メタ行 (検証担当/見積・経過/変更ファイル数)。
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
sql("delete from task_execution_tests where execution_id in (select te.id from task_executions te join tasks t on t.id=te.task_id where t.title like 'I02監査-%')");
sql("delete from task_executions where task_id in (select id from tasks where title like 'I02監査-%')");
sql("delete from knowledge_references where referrer_id in (select id from tasks where title like 'I02監査-%')");
sql("delete from tasks where title like 'I02監査-%' or title like '仕様変更対応: I02監査-%'");
sql("delete from mocks where screen_name like 'I02AUDIT-%'");
sql("delete from knowledge_nodes where title like 'I02監査ナレッジ-%'");

const uid = one("select id from users where email='design-audit@example.com'");
const proj = one(
  `select p.id from projects p join workspaces w on w.id=p.workspace_id where w.owner_user_id='${uid}' and p.deleted_at is null order by p.created_at limit 1`,
);
const ws = one(`select workspace_id from projects where id='${proj}'`);
const verifier = one(
  `select id from ai_employees e where e.workspace_id='${ws}' and e.name='vision' limit 1`,
);
const verifierName = one(`select display_name from ai_employees where id='${verifier}'`);

// シード: mock v1/v2 + task (mock v1 紐付け・検証担当・files_changed・spec_html_path)
const screen = `I02AUDIT-${mark}`;
const mockV1 = one(
  `insert into mocks (project_id, screen_name, html_storage_path, version) values ('${proj}','${screen}','mocks/${screen}-v1.html',1) returning id`,
);
const mockV2 = one(
  `insert into mocks (project_id, screen_name, html_storage_path, version) values ('${proj}','${screen}','mocks/${screen}-v2.html',2) returning id`,
);
const task = one(
  `insert into tasks (project_id, category, title, type, estimated_hours, lifecycle_stage, mock_id, spec_html_path, files_changed, verifier_employee_id) values ('${proj}','misc','I02監査-${mark}','screen',4,'in_progress','${mockV1}','specs/${screen}.html', array['a.tsx','b.tsx','c.tsx'], '${verifier}') returning id`,
);
const execId = one(
  `insert into task_executions (task_id, started_at, completed_at, status, score) values ('${task}', now() - interval '150 minutes', now() - interval '30 minutes', 'succeeded', 0.9) returning id`,
);
sql(
  `insert into task_execution_tests (execution_id, name, file, status, duration_ms) values ('${execId}','同意未取得でサインアップが失敗する-${mark}','tests/auth/consent.spec.ts','pass',800), ('${execId}','5 回失敗で 15 分ロック-${mark}','tests/auth/lockout.spec.ts','fail',null)`,
);
const kn = one(
  `insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md) values ('${ws}','workspace','common','dev','I02監査ナレッジ-${mark}','# ref') returning id`,
);
sql(
  `insert into knowledge_references (knowledge_id, referrer_type, referrer_id, reference_count) values ('${kn}','task','${task}',2)`,
);
check(!!task && !!execId && !!mockV2, `シード完了 (task ${task.slice(0, 8)} / mock v1→v2)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/tasks/detail?task=${task}`, { waitUntil: 'networkidle' });

// ④ メタ行
await page.getByText('あなたへの確認：仕様変更が検知されました').waitFor({ state: 'visible', timeout: 20000 });
check((await page.getByText(verifierName).count()) > 0, `④ 検証担当 実表示 (${verifierName})`);
check((await page.getByText(/4 時間 \//).count()) > 0 && (await page.getByText(/2 時間/).count()) > 0, '④ 見積 / 経過 (実 duration 2h)');
check((await page.getByText('3 件', { exact: true }).count()) > 0, '④ 変更ファイル数 (files_changed=3)');

// ① 仕様変更カード (v1 → v2)
check((await page.getByText(/v1 → v2/).count()) > 0, '① 仕様変更カード実描画 (v1 → v2)');
await page.screenshot({ path: `${SP}/i02-detail-${mark}.png` });

// ② テスト結果タブ
const testsTab = page.getByRole('tab', { name: /テスト結果/ });
await testsTab.waitFor({ state: 'visible', timeout: 10000 });
check((await testsTab.textContent())?.includes('1 / 2'), '② テスト結果タブカウント (1 / 2)');
await testsTab.click();
check(
  (await page.getByText(`同意未取得でサインアップが失敗する-${mark}`).count()) > 0 &&
    (await page.getByText('tests/auth/consent.spec.ts').count()) > 0,
  '② テストケース単位の実描画 (name + file)',
);

// ③ 関連資料タブ
await page.getByRole('tab', { name: /関連資料/ }).click();
check((await page.getByText(`設計モック ${screen}`).count()) > 0, '③ 関連資料: 実モックカード');
check((await page.getByText('変更 3 ファイル').count()) > 0, '③ 関連資料: ブランチ/変更ファイル');
check((await page.getByText(`I02監査ナレッジ-${mark}`).count()) > 0, '③ 関連資料: 参照ナレッジ (knowledge_references)');
await page.screenshot({ path: `${SP}/i02-detail-${mark}-tabs.png` });

// ① adopt → mock_id 差替 + カード消滅
await page.getByRole('button', { name: /最新仕様で実装し直す/ }).click();
await page.getByRole('button', { name: '確定' }).click();
await page.getByText(/取り込みました/).waitFor({ state: 'visible', timeout: 15000 });
check(one(`select mock_id from tasks where id='${task}'`) === mockV2, '① adopt: DB mock_id が v2 へ差替');
await page.reload({ waitUntil: 'networkidle' });
await page.getByText(`I02監査-${mark}`).first().waitFor({ state: 'visible', timeout: 20000 });
check(
  (await page.getByText('あなたへの確認：仕様変更が検知されました').count()) === 0,
  '① 解決後は再表示されない (metadata 記録)',
);

// ① split (別シードタスクで) → 実フォロータスク起票
const task2 = one(
  `insert into tasks (project_id, category, title, type, estimated_hours, lifecycle_stage, mock_id) values ('${proj}','misc','I02監査-split-${mark}','screen',4,'in_progress','${mockV1}') returning id`,
);
await page.goto(`http://localhost:3100/tasks/detail?task=${task2}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /現状の実装で完了にする/ }).click();
await page.getByRole('button', { name: '確定' }).click();
await page.getByText(/起票しました/).waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select count(*) from tasks where title='仕様変更対応: I02監査-split-${mark}' and category='仕様変更フォロー'`) === '1',
  '① split: 実フォロータスク起票 (仕様変更フォロー / triage)',
);
check(
  one(`select count(*) from audit_logs where action like 'task.spec_change.%' and target_id in ('${task}','${task2}')`) === '2',
  '① audit task.spec_change.* ×2',
);

await browser.close();
sql(`delete from task_execution_tests where execution_id='${execId}'`);
sql(`delete from task_executions where id='${execId}'`);
sql(`delete from knowledge_references where knowledge_id='${kn}'`);
sql(`delete from knowledge_nodes where id='${kn}'`);
sql(`delete from tasks where title like 'I02監査-%' or title like '仕様変更対応: I02監査-%'`);
sql(`delete from mocks where id in ('${mockV1}','${mockV2}')`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/i02-detail-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
