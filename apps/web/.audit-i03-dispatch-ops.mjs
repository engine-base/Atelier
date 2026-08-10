/**
 * GAP-026 実操作監査 (S-I03 実行モニターの運用操作系)
 *
 * 検証: ① Bridge 接続バッジ (実 /bridge/ping → presence) ② 同時実行枠表示
 * ③ 経過時間/着手・見積比 (実 started_at) ④ すべて一時停止 → pick 停止 (DB+実 API 突合)
 * → 再開 ⑤ 順番待ちから 1 件追加 (promoted_at) ⑥ キュー取消 ⑦ セッション停止
 * (2 段階確認 → reclaimed + execution cancelled) ⑧ ログ集約/一覧ビュー実描画。
 * 終了時にシード削除 + dispatch_control 復元 (再実行可能)。
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

// 前回残留掃除 + dispatch_control リセット
sql("delete from task_executions where task_id in (select id from tasks where title like 'I03監査-%')");
sql("delete from tasks where title like 'I03監査-%'");
sql("delete from bridge_workers where id like 'i03-audit-%'");
sql('update dispatch_control set paused = false, paused_by = null, paused_at = null where id = 1');

const uid = one("select id from users where email='design-audit@example.com'");
const proj = one(
  `select p.id from projects p join workspaces w on w.id=p.workspace_id where w.owner_user_id='${uid}' and p.deleted_at is null order by p.created_at limit 1`,
);

// シード: running (実行 6 分経過・見積 1h) ×1 + queued ×2
const tRun = one(
  `insert into tasks (project_id, category, title, type, estimated_hours, lifecycle_stage, dispatch_status, worker_pid) values ('${proj}','misc','I03監査-実行中-${mark}','feature',1,'in_progress','running',9999) returning id`,
);
const execRun = one(
  `insert into task_executions (task_id, started_at, status) values ('${tRun}', now() - interval '6 minutes', 'running') returning id`,
);
const tQ1 = one(
  `insert into tasks (project_id, category, title, type, estimated_hours, lifecycle_stage, dispatch_status, created_at) values ('${proj}','misc','I03監査-待ち古-${mark}','feature',2,'ready','queued', now() - interval '2 hours') returning id`,
);
const tQ2 = one(
  `insert into tasks (project_id, category, title, type, estimated_hours, lifecycle_stage, dispatch_status) values ('${proj}','misc','I03監査-待ち新-${mark}','feature',2,'ready','queued') returning id`,
);
check(!!tRun && !!execRun && !!tQ1 && !!tQ2, `シード完了 (running+queued×2)`);

// ① Bridge presence — 実 /bridge/ping (Bridge アプリと同じ経路)
const ping = execSync(
  `curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:8000/bridge/ping -H 'Content-Type: application/json' -H 'X-Bridge-Token: journey-bridge-token-0123456789' -d '{"worker_id":"i03-audit-${mark}","host_label":"AuditHost","version":"0.1.0","worker_pid":9999}'`,
  { encoding: 'utf8' },
).trim();
check(ping === '200', `実 /bridge/ping 200 (presence 登録)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1560, height: 950 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/tasks/monitor?project=${proj}`, { waitUntil: 'networkidle' });

// ①② バッジ + 並列枠
await page.getByText('ローカル Claude Code に接続中').waitFor({ state: 'visible', timeout: 20000 });
check((await page.getByText('Bridge v0.1.0 · AuditHost').count()) > 0, '① Bridge 接続バッジ (実 presence: version+host)');
check((await page.getByText(/あと \d 枠空いています/).count()) > 0, '② 同時実行枠の実表示');

// ③ 経過時間 + 着手・見積比 (started 6 分前 / 見積 1h → 残り ~54 分)
check((await page.getByText(/経過 6 分/).count()) > 0, '③ 経過時間の実測表示 (経過 6 分 X 秒)');
check((await page.getByText(/着手 · 見積比 残り 5[0-9] 分/).count()) > 0, '③ 着手時刻 + 見積比の残り表示');

// ⑤ 順番待ちから 1 件追加 → 最古 (待ち古) が昇格
await page.getByRole('button', { name: '順番待ちから 1 件追加' }).click();
await page.getByText(/次の空き枠で最優先開始します/).waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select (dispatch_promoted_at is not null)::text from tasks where id='${tQ1}'`) === 'true' &&
    one(`select (dispatch_promoted_at is null)::text from tasks where id='${tQ2}'`) === 'true',
  '⑤ 昇格は最古の queued のみ (promoted_at DB 突合)',
);

// ④ すべて一時停止 → DB + 実 pick が止まる → 再開
await page.getByRole('button', { name: 'すべて一時停止' }).click();
await page.getByText(/すべて一時停止中 — 新規の実行開始は止まっています/).waitFor({ state: 'visible', timeout: 15000 });
check(one('select paused::text from dispatch_control where id=1') === 'true', '④ DB: dispatch_control.paused=true');
const pickPaused = execSync(
  `curl -s -X POST http://localhost:8000/kanban/pick -H 'Content-Type: application/json' -H 'X-Bridge-Token: journey-bridge-token-0123456789' -d '{"worker_pid":9999}'`,
  { encoding: 'utf8' },
);
check(JSON.parse(pickPaused).data.no_available_task === true, '④ 一時停止中は実 /kanban/pick が no_available_task');
await page.getByRole('button', { name: '再開する' }).click();
await page.getByText('ディスパッチを再開しました').waitFor({ state: 'visible', timeout: 15000 });
check(one('select paused::text from dispatch_control where id=1') === 'false', '④ 再開で paused=false');

// ⑥ キュー取消 (待ち新)
await page.getByRole('button', { name: `順番待ちから取消: I03監査-待ち新-${mark}` }).click();
await page.getByText(/順番待ちから取り消しました/).waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select dispatch_status is null and lifecycle_stage='ready' from tasks where id='${tQ2}'`) === 't',
  '⑥ DB: 取消で dispatch 解除 + ready へ',
);

// ⑦ セッション停止 (2 段階確認) — 必ずシードカード内の停止ボタンを押す
// (プロジェクトに他の実行中タスクがあると first() は別カードに当たる)
const seedCard = page
  .locator('div.overflow-hidden.rounded-lg')
  .filter({ hasText: `I03監査-実行中-${mark}` })
  .first();
await seedCard.getByRole('button', { name: '停止', exact: true }).click();
await seedCard.getByText(/このセッションを停止しますか？/).waitFor({ state: 'visible', timeout: 10000 });
await seedCard.getByRole('button', { name: '確定' }).click();
await page.getByText(/セッションを停止しました/).waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select dispatch_status::text || '|' || lifecycle_stage::text from tasks where id='${tRun}'`) === 'reclaimed|blocked',
  '⑦ DB: 停止で reclaimed + blocked',
);
check(
  one(`select status::text from task_executions where id='${execRun}'`) === 'cancelled',
  '⑦ DB: 実行は cancelled で閉じる',
);
await page.screenshot({ path: `${SP}/i03-ops-${mark}.png` });

// ⑧ ログ集約 / 一覧ビュー
await page.getByRole('button', { name: 'ログ集約' }).click();
await page.getByText('[停止]').first().waitFor({ state: 'visible', timeout: 15000 });
check((await page.getByText(`I03監査-実行中-${mark}`).count()) > 0, '⑧ ログ集約: 実イベント (停止) 実描画');
await page.getByRole('button', { name: '一覧', exact: true }).click();
check((await page.getByRole('columnheader', { name: 'タスク' }).count()) > 0, '⑧ 一覧ビュー: テーブル実描画');
await page.screenshot({ path: `${SP}/i03-ops-${mark}-logs.png` });

await browser.close();
sql(`delete from task_executions where task_id in ('${tRun}','${tQ1}','${tQ2}')`);
sql(`delete from tasks where id in ('${tRun}','${tQ1}','${tQ2}')`);
sql(`delete from bridge_workers where id = 'i03-audit-${mark}'`);
sql('update dispatch_control set paused=false, paused_by=null, paused_at=null where id=1');
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/i03-ops-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
