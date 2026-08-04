/**
 * GAP-017 プロジェクト跨ぎナレッジ参照 実操作監査 (S-B03 + 検索 API)
 *
 * 1. design-audit WS に第 2 プロジェクト + 両プロジェクト由来のナレッジをシード
 * 2. S-B03 でトグルを実クリック OFF → DB settings.cross_project_knowledge=false 突合
 * 3. 実 JWT で POST /knowledge/search (project_id 付き):
 *    OFF → 他プロジェクト由来がヒットしない / 自プロジェクト+共通はヒット
 * 4. トグルを実クリック ON に戻す → 再び他プロジェクト分がヒット (往復)
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

const wsId = one(
  "select w.id from workspaces w join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' order by w.created_at limit 1",
);
const pidA = one(`select id from projects where workspace_id='${wsId}' and deleted_at is null order by created_at limit 1`);
const pidB = one(`insert into projects (workspace_id, name, project_type) values ('${wsId}','跨ぎ監査-${mark}','internal_product') returning id`);
const kA = one(`insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md, tags, source_project_id) values ('${wsId}','workspace','common','tech','跨ぎ監査A-${mark}','crossaudit-${mark} keyword','{tech}','${pidA}') returning id`);
const kB = one(`insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md, tags, source_project_id) values ('${wsId}','workspace','common','tech','跨ぎ監査B-${mark}','crossaudit-${mark} keyword','{tech}','${pidB}') returning id`);
check(!!pidB && !!kA && !!kB, `第 2 プロジェクト + ナレッジ 2 件シード`);

// 実 JWT (実 signin API)
const token = JSON.parse(
  execSync(
    `curl -s -X POST http://127.0.0.1:8000/auth/signin -H 'Content-Type: application/json' -d '{"email":"design-audit@example.com","password":"Passw0rd!123"}'`,
    { encoding: 'utf8' },
  ),
).data.access_token;
const search = () =>
  JSON.parse(
    execSync(
      `curl -s -X POST http://127.0.0.1:8000/knowledge/search -H 'Content-Type: application/json' -H 'Authorization: Bearer ${token}' -d '{"query":"crossaudit-${mark}","account_id":"${wsId}","project_id":"${pidA}","limit":20}'`,
      { encoding: 'utf8' },
    ),
  ).data.hits.map((h) => h.knowledge.id);

// 既定 ON: 両方ヒット
const before = search();
check(before.includes(kA) && before.includes(kB), `既定 ON: 両プロジェクトのナレッジがヒット (${before.length} 件)`);

// S-B03 でトグルを実クリック OFF
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/projects/settings?project=${pidA}`, { waitUntil: 'networkidle' });
const toggle = page.getByRole('checkbox', { name: 'プロジェクト跨ぎナレッジ参照' });
await toggle.waitFor({ state: 'visible', timeout: 15000 });
check(await toggle.isChecked(), 'トグル初期値 = ON (既定 true)');
await toggle.click({ force: true }); // sr-only input (視覚 track は peer)
await page.waitForTimeout(1500);
check(
  one(`select coalesce((settings ->> 'cross_project_knowledge')::boolean, true) from projects where id='${pidA}'`) === 'f',
  'DB: OFF が永続化 (settings.cross_project_knowledge=false)',
);

// OFF: 他プロジェクト由来 (kB) が消え、自プロジェクト (kA) は残る
const offHits = search();
check(offHits.includes(kA) && !offHits.includes(kB), `OFF: 他プロジェクト分が除外 (kA=${offHits.includes(kA)}, kB=${offHits.includes(kB)})`);

// ON へ戻す (往復)
await page.screenshot({ path: `${SP}/b03-cross-${mark}.png` });
await toggle.click({ force: true });
await page.waitForTimeout(1500);
check(
  one(`select coalesce((settings ->> 'cross_project_knowledge')::boolean, true) from projects where id='${pidA}'`) === 't',
  'DB: ON 復帰',
);
const onHits = search();
check(onHits.includes(kB), 'ON 復帰で再び跨ぎヒット');

await browser.close();
sql(`delete from knowledge_nodes where id in ('${kA}','${kB}')`);
sql(`delete from projects where id='${pidB}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/b03-cross-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
