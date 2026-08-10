/**
 * GAP-019 実操作監査 (S-T01 運営ダッシュボードの未描画セクション群)
 *
 * 検証: ① ミッションヒーロー — 目標未設定 → 記録フォーム → 実 phases (DB 突合) +
 * 実ペース表示 ② KPI bento 拡張 (実 platform-stats) ③ トレンド (週次実累計 SVG +
 * MRR ¥0 明示) ④ 取得チャネル記録 → バー実描画 ⑤ 健全性 (実計測行) ⑥ ベータ FB
 * (シード → 表示 → 対応済み化 DB 突合) ⑦ 運営コスト記録 → 合計 → 削除 ⑧ audit。
 * 終了時に記録を削除 (再実行可能)。
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
sql("delete from admin_goals where goal_key='acquisition'");
sql("delete from beta_feedback where content like 'T01監査-%'");
sql("delete from acquisition_records where note like 'T01監査-%' or (note = '' and created_at > now() - interval '5 minutes')");
sql("delete from admin_costs where name like 'T01監査-%'");

const uid = one("select id from users where email='design-audit@example.com'");
const wsCount = Number(one('select count(*) from workspaces where deleted_at is null'));
// FB シード (実ユーザー投稿相当)
const fb = one(
  `insert into beta_feedback (user_id, email, category, content) values ('${uid}','design-audit@example.com','bug','T01監査-再生を連打するとエラー-${mark}') returning id`,
);
check(!!fb && wsCount >= 0, `シード完了 (FB ${fb.slice(0, 8)} / 現在 WS ${wsCount} 社)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

await page.goto('http://localhost:3100/admin', { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: '運営ダッシュボード' }).waitFor({ state: 'visible', timeout: 20000 });

// ① 目標未設定 → 記録フォーム → 実ヒーロー
await page.getByText('獲得目標が未設定です').waitFor({ state: 'visible', timeout: 20000 });
check(true, '① 目標未設定は honest 表示 + 記録フォーム');
await page.getByLabel('目標タイトル').fill('100 社獲得');
await page.getByLabel('目標数').fill('100');
await page.getByLabel('期限').fill('2026-12-31');
await page.getByLabel(/メモ/).fill(`T01監査メモ-${mark}`);
await page.getByRole('button', { name: '目標を記録' }).click();
await page.getByText('獲得目標を記録しました。').waitFor({ state: 'visible', timeout: 15000 });
check(
  one("select target_count from admin_goals where goal_key='acquisition'") === '100',
  '① 目標が admin_goals に DB 永続',
);
const remaining = 100 - wsCount;
await page.getByText(`あと`, { exact: false }).first().waitFor({ state: 'visible', timeout: 15000 });
check((await page.getByText(`${remaining} 社`).count()) > 0, `① あと ${remaining} 社 (実 WS 数から実計算)`);
check((await page.getByText(`T01監査メモ-${mark}`).count()) > 0, '① メモ (運営記録) 表示');
await page.screenshot({ path: `${SP}/t01-${mark}-mission.png` });

// ② KPI bento 拡張
check((await page.getByText('タスク実行 / 30日').count()) === 1, '② KPI タスク実行/30日 (実集計)');
check((await page.getByText('稼働 Bridge 数').count()) === 1, '② KPI 稼働 Bridge 数');
check((await page.getByText('ベータ FB 件数').count()) === 1, '② KPI ベータ FB 件数');

// ③ トレンド + MRR 明示
check((await page.getByRole('img', { name: '週次トレンド' }).count()) === 1, '③ 週次トレンド実 SVG');
check(
  (await page.getByText('MRR: ¥0（課金未導入 — ベータ無料運用中のため実額）').count()) === 1,
  '③ MRR ¥0 を honest 明示',
);

// ④ 取得チャネル記録
await page.getByLabel('獲得チャネル').selectOption('referral');
await page.getByRole('button', { name: '獲得を記録' }).click();
await page.getByText(/獲得を記録しました（紹介・口コミ）/).waitFor({ state: 'visible', timeout: 15000 });
const acq = one("select id from acquisition_records order by created_at desc limit 1");
check(!!acq, '④ 獲得記録が acquisition_records に DB 永続');
check((await page.getByText('1 件').count()) >= 1, '④ チャネルバー実描画 (1 件)');

// ⑤ 健全性 (実計測)
check((await page.getByText('API ↔ DB 接続').count()) === 1, '⑤ 健全性: API↔DB 実測行');
check((await page.getByText(/DB roundtrip \d+ms \(実測\)/).count()) === 1, '⑤ 実測 latency 表示');
check((await page.getByText('PostgreSQL', { exact: true }).count()) === 1, '⑤ PostgreSQL 行 (実サイズ/接続数)');
check((await page.getByText('ディスパッチャ / Bridge').count()) === 1, '⑤ Bridge presence 行');

// ⑥ ベータ FB → 対応済み化
await page.getByText(`T01監査-再生を連打するとエラー-${mark}`).waitFor({ state: 'visible', timeout: 15000 });
check((await page.getByText('不具合').count()) >= 1, '⑥ FB カテゴリタグ実描画');
const fbCard = page
  .locator('div.mb-2.rounded-md, div.rounded-md.border')
  .filter({ hasText: `T01監査-再生を連打するとエラー-${mark}` })
  .filter({ has: page.getByRole('button', { name: '対応済みにする' }) })
  .first();
await fbCard.getByRole('button', { name: '対応済みにする' }).click();
await page.getByText('FB を対応済みにしました。').waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select status from beta_feedback where id='${fb}'`) === 'resolved',
  '⑥ resolve が DB 永続 (resolved)',
);
await page.screenshot({ path: `${SP}/t01-${mark}-panels.png` });

// ⑦ 運営コスト記録 → 合計 → 削除
await page.getByLabel('コスト項目名').fill(`T01監査-Fly.io-${mark}`);
await page.getByLabel('金額 (円)').fill('328');
await page.getByRole('button', { name: '記録', exact: true }).click();
await page.getByText('コストを記録しました。').waitFor({ state: 'visible', timeout: 15000 });
await page.getByText(`T01監査-Fly.io-${mark}`).waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select amount_yen from admin_costs where name='T01監査-Fly.io-${mark}'`) === '328',
  '⑦ コストが admin_costs に DB 永続 (月初正規化)',
);
check((await page.getByText('¥328').count()) >= 1, '⑦ 合計に実反映 (¥328)');
await page.screenshot({ path: `${SP}/t01-${mark}-cost.png` });
await page.getByRole('button', { name: `コスト T01監査-Fly.io-${mark} を削除` }).click();
await page.getByText(`T01監査-Fly.io-${mark}`).waitFor({ state: 'hidden', timeout: 15000 });
check(
  one(`select count(*) from admin_costs where name='T01監査-Fly.io-${mark}'`) === '0',
  '⑦ 削除が DB 反映',
);

// ⑧ audit 証跡
check(
  one(
    "select count(distinct action) from audit_logs where action in ('admin.goal.set','admin.acquisition.record','beta.feedback.resolve','admin.cost.record','admin.cost.delete') and created_at > now() - interval '5 minutes'",
  ) === '5',
  '⑧ audit 5 種 (goal.set / acquisition.record / feedback.resolve / cost.record / cost.delete)',
);

await browser.close();
sql("delete from admin_goals where goal_key='acquisition'");
sql(`delete from beta_feedback where id='${fb}'`);
sql(`delete from acquisition_records where id='${acq}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/t01-${mark}-*.png)`);
process.exit(failures === 0 ? 0 : 1);
