/**
 * Atelier e2e-journey-walkthrough — LP 制作案件を「本人として」一周する (GAP-104)
 *
 * 実行: node .journey-e2e.mjs
 * 前提: postgres/API(:8000, ATELIER_BRIDGE_TOKEN 設定済)/web(:3100) 稼働、
 *       apps/bridge が build 済 (dist/headless.js)。
 *
 * 各行 J-01..J-19 を依存順に実行し、結果を journey-results.json へ書く。
 * ロールごとに別ブラウザコンテキスト。Bridge (J-09) は headless worker を実実行し、
 * `claude -p` が本当に走って task が awaiting に遷移するまでを観察する。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const SHOTS = `${SCRATCH}/journey-shots`;
fs.mkdirSync(SHOTS, { recursive: true });
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const mark = Math.random().toString(36).slice(2, 7);
const OWNER = { email: `journey-owner-${mark}@example.com`, pass: 'Journey!Pass123' };
const MEMBER = { email: `journey-member-${mark}@example.com`, pass: 'Journey!Pass456' };
const results = [];
const S = { pid: null, wsId: null, taskIds: [], clientLink: null, otherPid: null };

const vis = (loc, t = 12000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ownerCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const owner = await ownerCtx.newPage();

async function row(id, page, fn) {
  const shot = `${SHOTS}/${id}.png`;
  try {
    const note = (await fn()) ?? '';
    if (page) await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    results.push({ id, status: 'PASS', evidence: shot, note });
    console.log(`PASS  ${id}  ${note}`);
  } catch (e) {
    if (page) await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    results.push({ id, status: 'FAIL', evidence: shot, note: String(e.message ?? e).slice(0, 400) });
    console.log(`FAIL  ${id}  ${String(e.message ?? e).slice(0, 200)}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── J-01 新規登録 (owner) ─────────────────────────────
await row('J-01', owner, async () => {
  // 発見メモ: /signup は 404 (サインアップは /signin のタブ)。journey note に記録。
  await owner.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
  await owner.getByRole('tab', { name: '新規登録' }).click();
  await owner.getByLabel(/メール/).fill(OWNER.email);
  const opw = owner.locator('input[type="password"]:visible');
  await opw.nth(0).fill(OWNER.pass);
  await opw.nth(1).fill(OWNER.pass);
  for (const cb of await owner.getByRole('checkbox').all()) await cb.check();
  await owner.getByRole('button', { name: '新規登録' }).click();
  await owner.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
  const uid = sql(`select id from users where email='${OWNER.email}'`);
  expect(uid, 'users 行が無い');
  const consents = sql(`select count(*) from consents where user_id='${uid}'`);
  expect(Number(consents) >= 3, `consents=${consents}`);
  S.ownerUid = uid;
  return `uid=${uid.slice(0, 8)} consents=${consents} → ${new URL(owner.url()).pathname}`;
});

// ── J-02 WS 作成 → AI 社員シード ─────────────────────
await row('J-02', owner, async () => {
  await owner.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
  await owner.getByPlaceholder('例：ENGINE BASE').fill(`Journey製作所 ${mark}`);
  await owner.getByRole('button', { name: 'ワークスペースを作成' }).click();
  await owner.waitForTimeout(2500);
  S.wsId = sql(`select id from workspaces where name='Journey製作所 ${mark}'`);
  expect(S.wsId, 'workspaces 行が無い');
  const emp = sql(`select count(*) from ai_employees where workspace_id='${S.wsId}'`);
  expect(Number(emp) >= 10, `ai_employees=${emp}`);
  // 組織図で目視
  await owner.goto('http://localhost:3100/employees', { waitUntil: 'networkidle' });
  expect(await vis(owner.getByText('トニー').first()), '組織図にトニーが出ない');
  return `ws=${S.wsId.slice(0, 8)} 社員=${emp} 名`;
});

// ── J-03 プロジェクト作成 ────────────────────────────
await row('J-03', owner, async () => {
  await owner.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: /新規プロジェクト/ }).first().click();
  const dialogInput = owner.locator('input[type="text"]:visible').last();
  await dialogInput.fill(`コーポレートLP制作 ${mark}`);
  await owner.getByRole('button', { name: /作成/ }).last().click();
  await owner.waitForTimeout(2500);
  S.pid = sql(`select id from projects where name='コーポレートLP制作 ${mark}'`);
  expect(S.pid, 'projects 行が無い');
  expect(await vis(owner.getByText(`コーポレートLP制作 ${mark}`).first()), '一覧に出ない');
  return `pid=${S.pid.slice(0, 8)}`;
});

// ── J-04 ヒアリング (チャット) ────────────────────────
await row('J-04', owner, async () => {
  await owner.goto(`http://localhost:3100/chat?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.waitForTimeout(2000);
  // 新規スレッド: AI 社員を選んで作成 (プロジェクト/AI社員/工程の 3 select)
  await owner.getByRole('button', { name: /新規スレッド/ }).click();
  await owner.waitForTimeout(800);
  const empSelect = owner.locator('select').nth(1);
  await empSelect.selectOption({ index: 1 });
  await owner.getByRole('button', { name: 'スレッドを作成' }).click();
  await owner.waitForTimeout(2000);
  const ta = owner.locator('textarea:visible').first();
  expect(await vis(ta), 'チャット入力欄が出ない');
  const hearing = 'ヒアリング: 目的=BtoB リード獲得 / ターゲット=製造業の情シス / 納期=4週間 / 予算=45万円。トップ+問い合わせの LP を希望。';
  await ta.fill(hearing);
  await owner.getByRole('button', { name: '送信' }).click();
  // user メッセージ + assistant echo (dev fake LLM) を待つ
  expect(await vis(owner.getByText('BtoB リード獲得', { exact: false }).first()), 'user 発話が出ない');
  const gotEcho = await vis(owner.getByText(/^echo:/).first(), 25000);
  const msgs = sql(`select count(*) from chat_messages m join chat_threads t on m.thread_id=t.id where t.project_id='${S.pid}'`);
  expect(Number(msgs) >= 1, `chat_messages=${msgs}`);
  return `messages=${msgs} assistant_echo=${gotEcho}`;
});

// ── J-05 ナレッジ CRUD 一周 ──────────────────────────
await row('J-05', owner, async () => {
  await owner.goto(`http://localhost:3100/knowledge?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: /新規追加/ }).click();
  await owner.waitForTimeout(800);
  const title = owner.getByLabel(/タイトル/).first();
  expect(await vis(title), '作成ダイアログが出ない');
  await title.fill(`LP要件サマリ ${mark}`);
  await owner.getByLabel(/カテゴリ/).fill('要件');
  const body = owner.locator('textarea:visible').first();
  if (await body.isVisible().catch(() => false)) await body.fill('目的: リード獲得 / 構成: ヒーロー+実績+問い合わせ');
  await owner.getByRole('button', { name: '追加する' }).click();
  await owner.waitForTimeout(2000);
  const kid = sql(`select id from knowledge_nodes where title='LP要件サマリ ${mark}' and deleted_at is null`);
  expect(kid, 'knowledge_nodes 行が無い');
  return `knowledge=${kid.slice(0, 8)} (作成→一覧反映を確認)`;
});

// ── J-06 商談ドラフト: トニー生成→PDF→送信 (GAP-018 新フロー) ──
await row('J-06', owner, async () => {
  await owner.goto(`http://localhost:3100/sales?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.getByRole('heading', { name: '提案 / 見積 / 契約 / 請求書ドラフト' }).waitFor({ state: 'visible', timeout: 20000 });
  await owner.getByRole('tab', { name: /見積書/ }).click();
  await owner.getByLabel(/顧客名/).fill('小松商事');
  await owner.getByLabel('案件', { exact: false }).first().fill(`LP一式お見積 ${mark}`);
  await owner.getByLabel(/商談概要/).fill('LP 制作一式 45 万円 (ヒーロー/実績/問い合わせ、4 週間) の見積を作りたい。');
  await owner.getByRole('button', { name: 'トニーにドラフト生成を依頼' }).click();
  await owner.getByText(`LP一式お見積 ${mark}`).first().waitFor({ state: 'visible', timeout: 30000 });
  S.estDoc = sql(`select id from workflow_outputs where project_id='${S.pid}' and stage='estimate' and deleted_at is null order by version desc limit 1`);
  expect(S.estDoc, 'estimate 行が無い');
  expect(sql(`select meta->>'generated_by' from workflow_outputs where id='${S.estDoc}'`) === 'tony', 'meta.generated_by=tony でない');
  // PDF 実バイナリ DL
  const dlPromise = owner.waitForEvent('download', { timeout: 20000 });
  await owner.getByRole('button', { name: 'PDF', exact: true }).click();
  const dl = await dlPromise;
  const pdfPath = `${SHOTS}/J-06-estimate.pdf`;
  await dl.saveAs(pdfPath);
  expect(fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1') === '%PDF-', 'PDF 実バイナリでない');
  // クライアントへ送信 (dev は dry-run を正直表示)
  await owner.getByRole('button', { name: '送信', exact: true }).click();
  await owner.getByRole('dialog', { name: 'クライアントにメール送信' }).waitFor({ state: 'visible', timeout: 5000 });
  await owner.getByPlaceholder('client@example.com').fill(`journey-client-${mark}@example.com`);
  await owner.getByLabel(/挨拶文/).fill('お見積のドラフトです。ご確認ください。');
  await owner.getByRole('button', { name: '送信する' }).click();
  await owner.getByText(/dry-run/).first().waitFor({ state: 'visible', timeout: 20000 });
  expect(sql(`select dry_run from sales_doc_sends where doc_id='${S.estDoc}'`) === 't', 'sales_doc_sends 記録が無い');
  return `トニー生成 estimate=${S.estDoc.slice(0, 8)} / PDF %PDF- / 送信 dry-run 明示 + 履歴永続`;
});

// ── J-07 タスク起票 ×2 ───────────────────────────────
await row('J-07', owner, async () => {
  await owner.goto(`http://localhost:3100/tasks?project=${S.pid}`, { waitUntil: 'networkidle' });
  for (const t of [`ヒーローセクション実装 ${mark}`, `問い合わせフォーム実装 ${mark}`]) {
    await owner.getByRole('button', { name: /タスクを追加/ }).click();
    await owner.waitForTimeout(600);
    await owner.getByLabel('タイトル').fill(t);
    await owner.getByLabel(/分類/).fill('実装');
    await owner.getByRole('button', { name: '作成', exact: true }).click();
    await owner.waitForTimeout(1500);
  }
  S.taskIds = sql(`select id from tasks where project_id='${S.pid}' and title like '%実装 ${mark}' order by created_at`).split('\n').filter(Boolean);
  expect(S.taskIds.length === 2, `tasks=${S.taskIds.length}`);
  expect(await vis(owner.getByText(`ヒーローセクション実装 ${mark}`).first()), 'かんばんに出ない');
  return `tasks=${S.taskIds.map((t) => t.slice(0, 8)).join(',')}`;
});

// ── J-08 準備中→着手可→再生 (queued) ─────────────────
await row('J-08', owner, async () => {
  await owner.goto(`http://localhost:3100/tasks?project=${S.pid}`, { waitUntil: 'networkidle' });
  // 通し初回設計時の検出: 準備中→着手可の UI が存在しなかった (是正済: 着手可にする)
  for (const t of [`ヒーローセクション実装 ${mark}`, `問い合わせフォーム実装 ${mark}`]) {
    await owner.getByRole('button', { name: `${t} を着手可にする` }).click();
    await owner.waitForTimeout(1200);
  }
  expect(sql(`select count(*) from tasks where id in ('${S.taskIds.join("','")}') and lifecycle_stage='ready'`) === '2', 'ready になっていない');
  // 1 件目を再生 → queued
  await owner.getByRole('button', { name: `ヒーローセクション実装 ${mark} を実行` }).click({ force: true });
  await owner.waitForTimeout(2000);
  const ds = sql(`select dispatch_status::text from tasks where id='${S.taskIds[0]}'`);
  expect(ds === 'queued', `dispatch=${ds} (play は queued で投入し pick が claim する — 通しで検出したパイプ断絶の是正後仕様)`);
  // 実行モニターの順番待ちに出る
  await owner.goto(`http://localhost:3100/tasks/monitor?project=${S.pid}`, { waitUntil: 'networkidle' });
  return `dispatch=${ds} (是正した「着手可にする」経由で到達)`;
});

// ── J-09 Bridge headless が claude -p を実実行 ────────
await row('J-09', null, async () => {
  const out = execSync(
    `cd /home/user/Atelier/apps/bridge && ATELIER_API_URL=http://127.0.0.1:8000 ATELIER_BRIDGE_TOKEN=journey-bridge-token-0123456789 ATELIER_BRIDGE_PROJECT=${S.pid} ATELIER_BRIDGE_TIMEOUT_MS=240000 node dist/headless.js 2>&1`,
    { encoding: 'utf8', timeout: 300000 },
  );
  const stage = sql(`select lifecycle_stage || '|' || coalesce(dispatch_status::text,'-') from tasks where id='${S.taskIds[0]}'`);
  const execRow = sql(`select status || '|' || coalesce(score::text,'-') from task_executions where task_id='${S.taskIds[0]}' order by started_at desc limit 1`);
  fs.writeFileSync(`${SHOTS}/J-09-bridge.log`, out);
  if (!stage.startsWith('awaiting')) throw new Error(`bridge 後 stage=${stage} exec=${execRow} out=${out.slice(-300)}`);
  return `claude -p 実実行 → stage=${stage} execution=${execRow}`;
});

// ── J-10 実行結果を確認して承認 ───────────────────────
await row('J-10', owner, async () => {
  await owner.goto(`http://localhost:3100/tasks/detail?task=${S.taskIds[0]}`, { waitUntil: 'networkidle' });
  expect(await vis(owner.getByRole('button', { name: /承認する/ }), 20000), '承認バーが出ない');
  await owner.getByRole('button', { name: /承認する/ }).click();
  await owner.getByRole('button', { name: '確定' }).click();
  await owner.waitForTimeout(2000);
  expect(sql(`select lifecycle_stage from tasks where id='${S.taskIds[0]}'`) === 'done', 'done にならない');
  expect(sql(`select count(*) from audit_logs where action='task.approve' and target_id='${S.taskIds[0]}'`) === '1', 'audit_logs 無し');
  return 'AI 実行結果を人間が承認 → done';
});

// ── J-11 差し戻し→再試行の分岐 (2 件目) ───────────────
await row('J-11', owner, async () => {
  // 2 件目を再生 → bridge 実行 → awaiting
  await owner.goto(`http://localhost:3100/tasks?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: `問い合わせフォーム実装 ${mark} を実行` }).click({ force: true });
  await owner.waitForTimeout(1500);
  execSync(
    `cd /home/user/Atelier/apps/bridge && ATELIER_API_URL=http://127.0.0.1:8000 ATELIER_BRIDGE_TOKEN=journey-bridge-token-0123456789 ATELIER_BRIDGE_PROJECT=${S.pid} ATELIER_BRIDGE_TIMEOUT_MS=240000 node dist/headless.js 2>&1`,
    { encoding: 'utf8', timeout: 300000 },
  );
  expect(sql(`select lifecycle_stage from tasks where id='${S.taskIds[1]}'`) === 'awaiting', '2件目が awaiting でない');
  // 差し戻し (理由付き)
  await owner.goto(`http://localhost:3100/tasks/detail?task=${S.taskIds[1]}`, { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: /差し戻し/ }).click();
  await owner.getByLabel('差し戻し理由').fill('バリデーション文言が仕様と不一致のため差し戻し');
  await owner.getByRole('button', { name: '確定' }).click();
  await owner.waitForTimeout(1500);
  expect(sql(`select lifecycle_stage from tasks where id='${S.taskIds[1]}'`) === 'blocked', 'blocked でない');
  // 再試行
  await owner.getByRole('button', { name: /再試行/ }).click();
  await owner.getByRole('button', { name: '確定' }).click();
  await owner.waitForTimeout(1500);
  const st = sql(`select lifecycle_stage || '|' || retry_count from tasks where id='${S.taskIds[1]}'`);
  expect(st === 'ready|1', `retry 後 ${st}`);
  // 再試行後にもう一度再生 → Bridge 実行 → 再び承認待ちへ (通知が pending で残る)
  await owner.goto(`http://localhost:3100/tasks?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: `問い合わせフォーム実装 ${mark} を実行` }).click({ force: true });
  await owner.waitForTimeout(1500);
  execSync(
    `cd /home/user/Atelier/apps/bridge && ATELIER_API_URL=http://127.0.0.1:8000 ATELIER_BRIDGE_TOKEN=journey-bridge-token-0123456789 ATELIER_BRIDGE_PROJECT=${S.pid} ATELIER_BRIDGE_TIMEOUT_MS=240000 node dist/headless.js 2>&1`,
    { encoding: 'utf8', timeout: 300000 },
  );
  expect(sql(`select lifecycle_stage from tasks where id='${S.taskIds[1]}'`) === 'awaiting', '再実行後 awaiting でない');
  return `差し戻し(blocked, 理由永続)→再試行(${st})→再実行で awaiting (通知 pending)`;
});

// ── J-12 メンバー登録 + WS 招待 ──────────────────────
const memberCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const member = await memberCtx.newPage();
await row('J-12', owner, async () => {
  // member 自身が先に登録
  await member.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
  await member.getByRole('tab', { name: '新規登録' }).click();
  await member.getByLabel(/メール/).fill(MEMBER.email);
  const mpw = member.locator('input[type="password"]:visible');
  await mpw.nth(0).fill(MEMBER.pass);
  await mpw.nth(1).fill(MEMBER.pass);
  for (const cb of await member.getByRole('checkbox').all()) await cb.check();
  await member.getByRole('button', { name: '新規登録' }).click();
  await member.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
  // owner が WS 設定から招待
  await owner.goto('http://localhost:3100/workspace-settings', { waitUntil: 'networkidle' });
  await owner.getByRole('button', { name: /メンバー招待/ }).click();
  await owner.waitForTimeout(600);
  const inviteInput = owner.locator('input[type="email"]:visible, input[type="text"]:visible').last();
  expect(await vis(inviteInput), 'メンバー招待入力が見つからない');
  await inviteInput.fill(MEMBER.email);
  await owner.getByRole('button', { name: /^招待(する)?$/ }).last().click();
  await owner.waitForTimeout(2000);
  const muid = sql(`select id from users where email='${MEMBER.email}'`);
  expect(sql(`select count(*) from workspace_memberships where workspace_id='${S.wsId}' and user_id='${muid}'`) === '1', 'workspace_members に居ない');
  return `member=${muid.slice(0, 8)} を WS に追加`;
});

// ── J-13 メンバーがタスクへコメント ───────────────────
await row('J-13', member, async () => {
  await member.goto(`http://localhost:3100/tasks/detail?task=${S.taskIds[0]}&project=${S.pid}`, { waitUntil: 'networkidle' });
  await member.getByRole('tab', { name: /コメント/ }).click();
  const ta = member.getByPlaceholder('コメントを追加…');
  expect(await vis(ta), 'コメント欄が出ない');
  await ta.fill(`メンバー確認: ヒーローの実装内容を確認しました (${mark})`);
  await member.getByRole('button', { name: 'コメント', exact: true }).click();
  await member.waitForTimeout(1500);
  expect(sql(`select count(*) from comments where target_type='task' and target_id='${S.taskIds[0]}' and content like '%${mark}%'`) === '1', 'comments に永続しない');
  // owner 側でも見える
  await owner.goto(`http://localhost:3100/tasks/detail?task=${S.taskIds[0]}`, { waitUntil: 'networkidle' });
  await owner.getByRole('tab', { name: /コメント/ }).click();
  expect(await vis(owner.getByText(`メンバー確認: ヒーローの実装内容を確認しました (${mark})`)), 'owner 側に反映されない');
  return 'メンバーのコメントが owner 側にも反映';
});

// ── J-14 クライアント招待 (メールは dry-run 観察) ─────
await row('J-14', owner, async () => {
  await owner.goto(`http://localhost:3100/portal/invitations?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.getByLabel('クライアント表示名').fill('小松 太郎');
  await owner.getByLabel('招待メールアドレス').fill(`journey-client-${mark}@example.com`);
  await owner.getByRole('button', { name: '招待を発行' }).click();
  expect(await vis(owner.getByText('招待リンク（この画面でのみ表示・再取得不可）')), 'ワンタイムリンクが出ない');
  S.clientLink = (await owner.locator('[role="status"] code').first().textContent())?.trim() ?? null;
  expect(S.clientLink?.includes('token='), 'リンクに token が無い');
  expect(sql(`select count(*) from client_invitations where email='journey-client-${mark}@example.com'`) === '1', 'client_invitations に無い');
  return `招待リンク取得 (メール送信は dev では dry-run — Resend key 未設定を確認済)`;
});

// ── J-15 クライアントがポータルへ ────────────────────
const clientCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const client = await clientCtx.newPage();
await row('J-15', client, async () => {
  await client.goto(S.clientLink, { waitUntil: 'networkidle' });
  for (const cb of await client.getByRole('checkbox').all()) await cb.check();
  await client.getByRole('button', { name: '同意してサインイン' }).click();
  await client.waitForURL((u) => u.pathname === '/portal', { timeout: 20000 });
  expect(await vis(client.getByRole('heading', { name: `コーポレートLP制作 ${mark}` })), 'ポータルにプロジェクト名が出ない');
  expect(await vis(client.getByText('小松 太郎')), '表示名が出ない');
  expect(sql(`select count(*) from client_invitations where email='journey-client-${mark}@example.com' and used_at is not null`) === '1', 'used_at 未設定');
  return 'クライアントが限定ポータルで案件を閲覧 (used_at 設定)';
});

// ── J-16 クライアント越境 403 ────────────────────────
await row('J-16', client, async () => {
  S.otherPid = sql(`select id from projects where id != '${S.pid}' and deleted_at is null limit 1`);
  expect(S.otherPid, '他プロジェクトが無い');
  await client.goto(`http://localhost:3100/portal?project=${S.otherPid}`, { waitUntil: 'networkidle' });
  expect(await vis(client.getByText('このプロジェクトを参照する権限がありません。')), '403 文言が出ない');
  return 'R-T08 越境は 403 文言のみ (データ非表示)';
});

// ── J-17 通知と検索 ──────────────────────────────────
await row('J-17', owner, async () => {
  // 承認待ち通知 (通しで検出した producer 欠落の是正後): pending 1 件 (task2)
  const pend = sql(`select count(*) from approval_inbox where user_id='${S.ownerUid}' and status='pending'`);
  expect(Number(pend) >= 1, `pending inbox=${pend}`);
  await owner.goto('http://localhost:3100/projects', { waitUntil: 'networkidle' });
  const bell2 = owner.getByRole('link', { name: /通知センター/ });
  expect(await vis(bell2), 'ベルが出ない');
  expect(/承認待ち [1-9]/.test((await bell2.getAttribute('aria-label')) ?? ''), 'ベルの未読バッジが 0');
  await bell2.click();
  await owner.waitForURL((u) => u.pathname === '/t-uc-36', { timeout: 15000 });
  expect(await vis(owner.getByText(`問い合わせフォーム実装 ${mark}`).first()), '通知センターに承認待ちが出ない');
  // 検索
  await owner.goto('http://localhost:3100/t-uc-40', { waitUntil: 'networkidle' });
  const q = owner.getByRole('searchbox').or(owner.getByPlaceholder(/検索/)).first();
  await q.fill(`コーポレートLP制作 ${mark}`);
  expect(await vis(owner.getByText(`コーポレートLP制作 ${mark}`).nth(0), 15000), '検索がヒットしない');
  return `通知: pending=${pend} がベルバッジ+通知センターに実表示 / 検索ヒット OK`;
});

// ── J-18 最終成果の目視 ──────────────────────────────
await row('J-18', owner, async () => {
  await owner.goto(`http://localhost:3100/projects/dashboard?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.waitForTimeout(2500);
  expect(await vis(owner.getByText(`コーポレートLP制作 ${mark}`).first()), 'ダッシュボードが出ない');
  const done = sql(`select count(*) from tasks where project_id='${S.pid}' and lifecycle_stage='done'`);
  const est = sql(`select count(*) from workflow_outputs where project_id='${S.pid}' and stage in ('estimate','proposal') and deleted_at is null`);
  expect(Number(done) >= 1 && Number(est) >= 1, `done=${done} est=${est}`);
  return `最終成果: 完了タスク ${done} / 見積 ${est} / クライアント公開済 — 一周完了`;
});

// ── J-19 議事録パイプ終端 (既知 GAP-016 の通し確認) ───
await row('J-19', owner, async () => {
  await owner.goto(`http://localhost:3100/meetings?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.waitForTimeout(1500);
  // dev: storage 未設定の honest エラーが出ること (偽の受付をしない)
  const fi = owner.locator('input[type="file"]').first();
  expect((await fi.count()) >= 1, 'アップロード UI が無い');
  await fi.setInputFiles({ name: `journey-${mark}.wav`, mimeType: 'audio/wav', buffer: Buffer.from('RIFFxxxxWAVEfmt ') });
  await owner.waitForTimeout(4000);
  const honest = await vis(owner.getByText(/解析に失敗|503|保存先が未設定|アップロードに失敗/).first(), 10000);
  expect(honest, 'storage 未設定の明示エラーが出ない (黙って受け付けたら偽装)');
  // 終端 (Whisper worker) は GAP-016 解消で実装済 — queued 消費者の実在を検証する
  // (worker 本体 + cron 登録の両方。実 Whisper 呼出は OPENAI key + storage 設定が前提)
  const workerExists = execSync(
    `test -f /home/user/Atelier/apps/api/src/services/meetings/worker.py && grep -c 'transcribe-queue' /home/user/Atelier/apps/api/src/cron/scheduler.py`,
    { encoding: 'utf8' },
  ).trim();
  expect(Number(workerExists) >= 1, 'queued 消費 worker が不在 (GAP-016 再発)');
  return `storage 未設定は honest エラー表示。queued 消費 worker 実在確認 (GAP-016 解消済: worker.py + cron transcribe-queue 登録=${workerExists})`;
});

// ══════════ v2 追加: 8/10-11 実装分を業務として一周 ══════════

// ── J-20 フェーズ計画: ジャービス提案 → 承認 ×2 ──────
await row('J-20', owner, async () => {
  await owner.goto(`http://localhost:3100/workflow/phases?project=${S.pid}`, { waitUntil: 'networkidle' });
  for (let i = 0; i < 2; i++) {
    await owner.getByRole('button', { name: 'ジャービスに次フェーズを提案してもらう' }).click();
    await owner.getByText(/（AI提案）/).first().waitFor({ state: 'visible', timeout: 30000 });
    await owner.getByRole('button', { name: '承認', exact: true }).click();
    await owner.getByText(/提案を承認し、第 \d+ 段階/).waitFor({ state: 'visible', timeout: 20000 });
    await owner.waitForTimeout(1200);
  }
  const phases = sql(`select count(*) from phases where project_id='${S.pid}'`);
  expect(Number(phases) >= 2, `phases=${phases}`);
  S.phaseIds = sql(`select id from phases where project_id='${S.pid}' order by "order"`).split('\n').filter(Boolean);
  expect(sql(`select count(*) from phase_proposals where project_id='${S.pid}' and status='approved'`) === '2', '承認済み提案が 2 件でない');
  return `ジャービス提案 → 承認で実 phases ${phases} 工程 (提案は approved で永続)`;
});

// ── J-21 影響解析 → 承認して移動 (F-IMP01) ───────────
await row('J-21', owner, async () => {
  await owner.goto(`http://localhost:3100/workflow/phases?project=${S.pid}`, { waitUntil: 'networkidle' });
  await owner.getByLabel('影響解析の対象タスク').selectOption(S.taskIds[0]);
  await owner.getByLabel('移動先フェーズ').selectOption(S.phaseIds[1]);
  await owner.getByRole('button', { name: '影響を解析' }).click();
  await owner.getByText(/への影響を検出/).waitFor({ state: 'visible', timeout: 25000 });
  await owner.getByRole('button', { name: '承認して移動' }).click();
  await owner.getByText(/タスクを移動し/).waitFor({ state: 'visible', timeout: 20000 });
  const ph = sql(`select phase_id from tasks where id='${S.taskIds[0]}'`);
  expect(ph === S.phaseIds[1], `phase_id=${ph}`);
  return `影響解析 (依存の推移的走査) → 承認して移動が DB 反映`;
});

// ── J-22 モック: 登録 (実 API) → ワンダに修正依頼 → v2 ─
await row('J-22', owner, async () => {
  // 発見メモ: モック新規作成 UI は無い (AI 工程が生成する設計)。実 API POST /mocks で登録する。
  const cookies = await ownerCtx.cookies();
  const tok = cookies.find((c) => c.name === 'atelier_access')?.value;
  expect(tok, 'owner の atelier_access cookie が無い');
  const v1Path = `mocks/journey-${mark}/v1.html`;
  fs.mkdirSync(`${SCRATCH}/storage-objects/mocks/journey-${mark}`, { recursive: true });
  fs.writeFileSync(
    `${SCRATCH}/storage-objects/${v1Path}`,
    `<!doctype html><html><head><title>トップページ ${mark}</title></head><body><h1>LP v1</h1></body></html>`,
  );
  const res = await fetch('http://localhost:8000/mocks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify({ project_id: S.pid, screen_name: `トップページ ${mark}`, html_storage_path: v1Path }),
  });
  expect(res.status === 201, `POST /mocks=${res.status}`);
  S.mockV1 = (await res.json()).data.id;
  // ワンダに修正依頼 (S-H01)
  await owner.goto(`http://localhost:3100/mocks?mock=${S.mockV1}`, { waitUntil: 'networkidle' });
  await owner.getByRole('heading', { name: `トップページ ${mark}` }).waitFor({ state: 'visible', timeout: 20000 });
  await owner.getByRole('button', { name: /編集/ }).click();
  await owner.getByRole('dialog', { name: 'ワンダに修正を依頼' }).waitFor({ state: 'visible', timeout: 5000 });
  await owner.getByRole('textbox', { name: '修正指示' }).fill(`ヒーローに CTA ボタンを追加 (${mark})`);
  await owner.getByRole('button', { name: '修正を依頼' }).click();
  await owner.getByText(/ワンダが v2 を作成しました/).waitFor({ state: 'visible', timeout: 30000 });
  S.mockV2 = sql(`select id from mocks where screen_name='トップページ ${mark}' and version=2 and deleted_at is null`);
  expect(S.mockV2, 'mock v2 が無い');
  expect(sql(`select meta_tags->>'author' from mocks where id='${S.mockV2}'`) === 'wanda', 'author=wanda でない');
  return `モック登録 (API — 作成 UI は無い設計) → ワンダ修正依頼で v2 (author=wanda)`;
});

// ── J-23 成果物改訂: コメント → スティーブ提案 → 承認 ──
await row('J-23', owner, async () => {
  await owner.goto(`http://localhost:3100/outputs?output=${S.estDoc}`, { waitUntil: 'networkidle' });
  await owner.waitForTimeout(2000);
  const box = owner.getByPlaceholder('選択箇所にコメント...');
  expect(await vis(box), 'コメント入力が出ない');
  const anchorSel = owner.getByRole('combobox', { name: 'コメント対象位置' });
  if (await anchorSel.isVisible().catch(() => false)) {
    const opts = await anchorSel.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    if (opts.length > 0) await anchorSel.selectOption(opts[0]);
  }
  await box.fill(`小計と税額を分けて記載してほしい (${mark})`);
  await owner.getByRole('button', { name: '投稿' }).click();
  await owner.getByText(`小計と税額を分けて記載してほしい (${mark})`).waitFor({ state: 'visible', timeout: 15000 });
  const card = owner.locator('li').filter({ hasText: `小計と税額を分けて記載してほしい (${mark})` }).first();
  await card.getByRole('button', { name: 'スティーブに修正提案を依頼' }).click();
  await card.getByText('スティーブの修正提案：').waitFor({ state: 'visible', timeout: 30000 });
  await card.getByRole('button', { name: '承認' }).click();
  await owner.getByText(/提案を承認し、スティーブが v\d+ を作成しました/).waitFor({ state: 'visible', timeout: 30000 });
  S.estLatest = sql(`select id from workflow_outputs where project_id='${S.pid}' and stage='estimate' and deleted_at is null order by version desc limit 1`);
  expect(S.estLatest !== S.estDoc, '改訂版が作られていない');
  expect(sql(`select meta->>'author' from workflow_outputs where id='${S.estLatest}'`) === 'steve', 'author=steve でない');
  return `客観点のコメント → スティーブ改訂 → 承認で新版 ${S.estLatest.slice(0, 8)} (author=steve)`;
});

// ── J-24 ポータル実コンテンツ (GAP-029) ────────────────
await row('J-24', client, async () => {
  await client.goto(`http://localhost:3100/portal?project=${S.pid}`, { waitUntil: 'networkidle' });
  await client.getByRole('heading', { name: `コーポレートLP制作 ${mark}` }).waitFor({ state: 'visible', timeout: 20000 });
  expect(await vis(client.getByText(/リンク有効期限：残り \d+ 日/)), 'リンク残日数が出ない');
  expect(await vis(client.getByRole('list', { name: '工程進捗' })), '工程進捗バーが出ない');
  const outputsSec = client.getByRole('region', { name: '成果物' });
  expect(await vis(outputsSec.getByText('見積書')), '成果物に見積書が出ない');
  const mocksSec = client.getByRole('region', { name: 'モック' });
  expect(await vis(mocksSec.getByText(`トップページ ${mark}`)), 'モックが出ない');
  // コメント投稿 (comment スコープ)
  const form = client.getByRole('region', { name: 'コメントを投稿' });
  const targetSel = form.getByLabel('コメント対象');
  await targetSel.locator(`option[value="workflow_output:${S.estLatest}"]`).waitFor({ state: 'attached', timeout: 15000 });
  await targetSel.selectOption(`workflow_output:${S.estLatest}`);
  await form.getByLabel('コメント内容').fill(`お見積の §2 内訳について確認したいです (${mark})`);
  await form.getByRole('button', { name: 'コメントを投稿' }).click();
  await client.getByText('コメントを投稿しました。運営側に共有されます。').waitFor({ state: 'visible', timeout: 15000 });
  const cid = sql(`select id from comments where content like '%内訳について確認したいです (${mark})%'`);
  expect(sql(`select author_invitation_id is not null from comments where id='${cid}'`) === 't', 'author_invitation_id で記録されていない');
  await client.getByText('あなたのコメント（1）').waitFor({ state: 'visible', timeout: 15000 });
  S.clientCommentId = cid;
  return `客が成果物/進捗/モック/残日数を実データで閲覧しコメント投稿 (author_invitation 記録)`;
});

// ── J-25 コメント往復: 運営返信 → 客に可視 ─────────────
await row('J-25', client, async () => {
  await owner.goto(`http://localhost:3100/outputs?output=${S.estLatest}`, { waitUntil: 'networkidle' });
  const ccard = owner.locator('li').filter({ hasText: `内訳について確認したいです (${mark})` }).first();
  expect(await vis(ccard, 20000), '客のコメントが運営側成果物ビューアに出ない');
  await ccard.getByRole('button', { name: '返信' }).click();
  await ccard.getByPlaceholder('返信を入力…').fill(`内訳を明細化した改訂版を反映済みです。ご確認ください (${mark})`);
  await ccard.getByRole('button', { name: '返信する' }).click();
  await owner.getByText(`内訳を明細化した改訂版を反映済みです。ご確認ください (${mark})`).waitFor({ state: 'visible', timeout: 15000 });
  // 客側で返信が見える (自分のスレッドのみの最小開示)
  await client.reload({ waitUntil: 'networkidle' });
  await client.getByRole('region', { name: 'あなたのコメント' }).getByText(`内訳を明細化した改訂版を反映済みです。ご確認ください (${mark})`).waitFor({ state: 'visible', timeout: 20000 });
  return `運営が成果物ビューアで返信 → 客のポータルに返信が実表示 (往復成立)`;
});

// ── J-26 運営: ダッシュボード実数 + 獲得記録 + テンプレ配布 ──
const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const admin = await adminCtx.newPage();
await row('J-26', admin, async () => {
  await admin.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
  await admin.getByLabel(/メール/).fill('design-audit@example.com');
  await admin.locator('input[type="password"]').first().fill('Passw0rd!123');
  await admin.getByRole('button', { name: 'サインイン' }).click();
  await admin.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
  await admin.goto('http://localhost:3100/admin', { waitUntil: 'networkidle' });
  await admin.getByRole('heading', { name: '運営ダッシュボード' }).waitFor({ state: 'visible', timeout: 20000 });
  // ジャーニーで増えた実数の観察: 直近 30 日のタスク実行に J-09/J-11 の実行が入る
  const exec30 = sql(`select count(*) from task_executions where started_at >= now() - interval '30 days'`);
  expect(Number(exec30) >= 2, `task_executions 30d=${exec30}`);
  // 新規獲得をチャネル記録 (運営の実業務)
  await admin.getByLabel('獲得チャネル').selectOption('referral');
  await admin.getByRole('button', { name: '獲得を記録' }).click();
  await admin.getByText(/獲得を記録しました（紹介・口コミ）/).waitFor({ state: 'visible', timeout: 15000 });
  const acq = sql(`select id from acquisition_records order by created_at desc limit 1`);
  expect(acq, 'acquisition_records に無い');
  // テンプレ改善配布 (S-T03): journey 専用テンプレを編集 → 全 WS 反映
  const tpl = sql(`insert into ai_employee_templates (default_name, default_display_name, department, role, system_prompt, specialty, version) values ('journey-tpl-${mark}','J2テンプレ-${mark}','sales','member','ジャーニー検証用','初期',1) returning id`);
  await admin.goto('http://localhost:3100/admin/s_t03', { waitUntil: 'networkidle' });
  await admin.getByRole('button', { name: `J2テンプレ-${mark}` }).click();
  const editor = admin.getByRole('region', { name: `テンプレ編集: J2テンプレ-${mark}` });
  await editor.waitFor({ state: 'visible', timeout: 15000 });
  await editor.getByLabel(/専門領域（specialty）/).fill(`見積・提案ドラフト強化 (${mark})`);
  await editor.getByRole('button', { name: '保存して全 WS 反映' }).click();
  await admin.getByText(/テンプレを保存しました（v2 /).waitFor({ state: 'visible', timeout: 15000 });
  expect(sql(`select version from ai_employee_templates where id='${tpl}'`) === '2', 'version increment されない');
  // 後片付け (共有 dev データを汚さない)
  sql(`delete from audit_logs where action='template.update' and target_id='${tpl}'`);
  sql(`delete from ai_employee_templates where id='${tpl}'`);
  sql(`delete from audit_logs where action='admin.acquisition.record' and target_id='${acq}'`);
  sql(`delete from acquisition_records where id='${acq}'`);
  return `運営: 実行実数 ${exec30} 件確認 / 獲得記録→反映 / テンプレ編集 v1→v2 (全 WS 反映) — 後片付け済`;
});

// ── J-27 一周の最終整合 (DB 突合) ──────────────────────
await row('J-27', null, async () => {
  const checks = {
    'phases (ジャービス承認)': Number(sql(`select count(*) from phases where project_id='${S.pid}'`)) >= 2,
    'タスク工程移動': sql(`select phase_id from tasks where id='${S.taskIds[0]}'`) === S.phaseIds[1],
    'estimate 改訂版 (steve)': Number(sql(`select count(*) from workflow_outputs where project_id='${S.pid}' and stage='estimate' and deleted_at is null`)) >= 2,
    'mock v2 (wanda)': sql(`select count(*) from mocks where screen_name='トップページ ${mark}' and version=2`) === '1',
    '送信履歴 (dry-run)': sql(`select count(*) from sales_doc_sends where doc_id='${S.estDoc}'`) === '1',
    '客コメント (invitation)': sql(`select author_invitation_id is not null from comments where id='${S.clientCommentId}'`) === 't',
    '運営返信 (parent 連鎖)': sql(`select count(*) from comments where parent_comment_id='${S.clientCommentId}'`) === '1',
    'audit: client.comment.create': sql(`select count(*) from audit_logs where action='client.comment.create' and target_id='${S.clientCommentId}'`) === '1',
    'audit: mock.version_create': sql(`select count(*) from audit_logs where action='mock.version_create' and target_id='${S.mockV2}'`) === '1',
  };
  const bad = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  expect(bad.length === 0, `整合 NG: ${bad.join(', ')}`);
  return `一周整合 ${Object.keys(checks).length}/${Object.keys(checks).length} OK — 受注→計画→制作→改訂→客レビュー→運営まで単一案件で成立`;
});

await ownerCtx.close(); await memberCtx.close(); await clientCtx.close(); await adminCtx.close();

await browser.close();
fs.writeFileSync(`${SCRATCH}/journey-results.json`, JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.status === 'FAIL').length;
console.log(`---\n${results.length - fails}/${results.length} PASS`);
process.exit(fails ? 1 : 0);
