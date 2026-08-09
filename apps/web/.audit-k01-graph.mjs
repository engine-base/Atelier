/**
 * GAP-010 ナレッジグラフ実操作監査 (S-K01 グラフビュー)
 *
 * シード: 親子 (parent_id) + タグ共起の 3 ノード → S-K01 でグラフトグルを
 * 実クリック → ノード数/リンク数の実表示 → SVG ノード・エッジ描画 →
 * ノードクリックで実 GET /knowledge/{id} → ノートビューに本文表示。
 * DB 突合: /knowledge/graph の実応答 (実 JWT) にシードの parent/tag エッジ。
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
// 前回 run の残留掃除 (クラッシュ時にクリーンアップ未達だとラベルが重なり
// クリックを妨害する)
sql(`delete from knowledge_nodes where title similar to 'グラフ(親|子|共起)-%'`);
const kParent = one(
  `insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md, tags) values ('${wsId}','workspace','common','tech','グラフ親-${mark}','graph parent body','{gaudit-${mark}}') returning id`,
);
const kChild = one(
  `insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md, tags, parent_id) values ('${wsId}','workspace','common','tech','グラフ子-${mark}','graph child body','{}','${kParent}') returning id`,
);
const kTagged = one(
  `insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md, tags) values ('${wsId}','workspace','common','tech','グラフ共起-${mark}','graph tagged body','{gaudit-${mark}}') returning id`,
);
check(!!kParent && !!kChild && !!kTagged, `3 ノードシード (親子 + タグ共起)`);

// 実 JWT で API 突合 (parent + tag エッジが実導出されるか)
const token = JSON.parse(
  execSync(
    `curl -s -X POST http://127.0.0.1:8000/auth/signin -H 'Content-Type: application/json' -d '{"email":"design-audit@example.com","password":"Passw0rd!123"}'`,
    { encoding: 'utf8' },
  ),
).data.access_token;
const graph = JSON.parse(
  execSync(
    `curl -s 'http://127.0.0.1:8000/knowledge/graph?account_id=${wsId}' -H 'Authorization: Bearer ${token}'`,
    { encoding: 'utf8' },
  ),
).data;
const edgeSet = new Set(graph.edges.map((e) => `${e.source}|${e.target}|${e.kind}`));
check(edgeSet.has(`${kParent}|${kChild}|parent`), 'API: parent 階層エッジ導出');
const [ta, tb] = [kParent, kTagged].sort();
const tagEdge = graph.edges.find((e) => e.kind === 'tag' && e.source === ta && e.target === tb);
check(tagEdge?.tag === `gaudit-${mark}`, `API: タグ共起エッジ導出 (tag=${tagEdge?.tag})`);

// S-K01 実 UI
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/knowledge?workspace=${wsId}`, { waitUntil: 'networkidle' });

const graphToggle = page.getByRole('button', { name: 'グラフ', exact: true });
await graphToggle.waitFor({ state: 'visible', timeout: 15000 });
await graphToggle.click();
const fig = page.getByRole('figure', { name: 'ナレッジグラフ' });
await fig.waitFor({ state: 'visible', timeout: 15000 });
check((await graphToggle.getAttribute('aria-pressed')) === 'true', 'グラフトグル押下状態');
const figText = await fig.innerText();
check(/ノード \d+ 件 · リンク \d+ 本/.test(figText), `ノード/リンク数の実表示 (${figText.split('\n')[0].slice(0, 40)}…)`);

// シードした 3 ノードが SVG に実描画
for (const t of [`グラフ親-${mark}`, `グラフ子-${mark}`, `グラフ共起-${mark}`]) {
  check((await fig.getByRole('button', { name: `ナレッジ: ${t}` }).count()) === 1, `SVG ノード描画: ${t}`);
}
await page.screenshot({ path: `${SP}/k01-graph-${mark}.png` });

// ノードクリック → 実 GET /knowledge/{id} → ノートビューに本文
// 円周配置でラベルが隣接ノードに重なることがあるため force (対象実在は上で検証済)
await fig.getByRole('button', { name: `ナレッジ: グラフ親-${mark}` }).click({ force: true });
await page.getByRole('heading', { level: 2, name: `グラフ親-${mark}` }).waitFor({ state: 'visible', timeout: 15000 });
check((await page.getByText('graph parent body').count()) > 0, 'ノードクリック → ノートビューに本文実表示');

await browser.close();
sql(`delete from knowledge_nodes where id in ('${kChild}','${kTagged}','${kParent}')`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/k01-graph-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
