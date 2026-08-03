/**
 * GAP-006 依存グラフ 実操作監査 (S-I01)
 *
 * 実 UI で: 依存関係付きタスク 3 件 (A ← B ← C, A ← C) をシード →
 * タスクボードの表示トグル「依存グラフ」に切替 → 層別ノード 3 + SVG 辺 3 本
 * → ノードがタスク詳細への実リンク → クリックで詳細に遷移。
 * 終了時にシードを論理削除 (再実行可能)。
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
const ins = (title, deps) =>
  one(
    `insert into tasks (project_id, category, title, type, estimated_hours, priority, lifecycle_stage, dependencies) ` +
      `values ('${pid}','misc','${title}','feature',2,'medium','ready',${deps}) returning id`,
  );
const a = ins(`依存監査A-${mark} DB設計`, 'ARRAY[]::uuid[]');
const b = ins(`依存監査B-${mark} API実装`, `ARRAY['${a}']::uuid[]`);
const c = ins(`依存監査C-${mark} UI実装`, `ARRAY['${a}','${b}']::uuid[]`);
check(!!a && !!b && !!c, `依存付きタスク 3 件シード (${a.slice(0, 8)}←${b.slice(0, 8)}←${c.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/tasks?project=${pid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// 依存グラフへ切替 (絞込にマークを入れてシード 3 件のみに)
await page.getByPlaceholder(/絞り込み|検索/).first().fill(`依存監査`).catch(() => {});
await page.waitForTimeout(600);
const toggle = page.getByRole('button', { name: '依存グラフ' });
await toggle.waitFor({ state: 'visible', timeout: 15000 });
await toggle.click();
check((await toggle.getAttribute('aria-pressed')) === 'true', '表示トグル「依存グラフ」切替 (aria-pressed)');

// ノード 3 + 辺 3 (SVG path)
const img = page.getByRole('img', { name: /依存グラフ: タスク/ });
await img.waitFor({ state: 'visible', timeout: 10000 });
const label = (await img.getAttribute('aria-label')) ?? '';
check(/タスク 3 件 \/ 依存 3 本/.test(label), `グラフ集計 (${label})`);
const edges = await page.locator('[data-testid="deps-edge"]').count();
check(edges === 3, `SVG 辺 3 本描画 (実際: ${edges})`);

// ノード = 詳細への実リンク → 遷移
const nodeB = page.getByRole('link', { name: new RegExp(`依存監査B-${mark}`) });
check(await nodeB.isVisible(), 'ノードが詳細への実リンク');
await page.screenshot({ path: `${SP}/i01-deps-${mark}.png` });
await nodeB.click();
await page.waitForURL((u) => u.pathname === '/tasks/detail', { timeout: 15000 });
check(page.url().includes(`task=${b}`), 'ノードクリックで S-I02 詳細へ遷移');

await browser.close();
sql(`update tasks set deleted_at=now() where id in ('${a}','${b}','${c}')`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/i01-deps-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
