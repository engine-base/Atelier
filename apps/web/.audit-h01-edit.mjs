/**
 * GAP-024 実操作監査 (S-H01 モック「編集」+ バージョン操作)
 *
 * 検証: ①「編集」= ワンダ (AI デザイナー) への修正依頼 → LLM (fake) が HTML を
 * 改訂 → 新バージョン v2 生成 (DB 突合 + storage 実バナー確認 + パネルに
 * 「ワンダ（更新）」/ 修正指示表示) — Open Design パターン準拠 ② 複製 → v3
 * (同一 HTML 参照 + 「v2 の複製」表示) ③ 破棄 (2 段階確認 + soft delete)
 * ④ 唯一版の破棄は 409 → honest エラー表示。終了時にシード削除 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
sql("delete from mocks where screen_name like 'H01EDIT-%'");

const uid = one("select id from users where email='design-audit@example.com'");
const proj = one(
  `select p.id from projects p join workspaces w on w.id=p.workspace_id where w.owner_user_id='${uid}' and p.deleted_at is null order by p.created_at limit 1`,
);

// シード: v1 の実 HTML を storage スタブ実体に配置 + mocks 行
const screen = `H01EDIT-${mark}`;
const v1Path = `mocks/h01edit-${mark}/v1.html`;
execSync(`mkdir -p ${SP}/storage-objects/mocks/h01edit-${mark}`);
execSync(
  `cat > ${SP}/storage-objects/${v1Path} <<'EOF'
<!doctype html><html><head><title>${screen}</title></head><body><h1>v1 original</h1></body></html>
EOF`,
);
const mockV1 = one(
  `insert into mocks (project_id, screen_name, html_storage_path, version) values ('${proj}','${screen}','${v1Path}',1) returning id`,
);
check(!!mockV1, `シード完了 (mock v1 ${mockV1.slice(0, 8)} + storage 実体)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

// ① 編集 = ワンダへの修正依頼
await page.goto(`http://localhost:3100/mocks?mock=${mockV1}`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: screen }).waitFor({ state: 'visible', timeout: 20000 });
await page.getByRole('button', { name: /編集/ }).click();
await page.getByRole('dialog', { name: 'ワンダに修正を依頼' }).waitFor({ state: 'visible', timeout: 5000 });
const INSTRUCTION = `ヘッダーをブランドカラーに変更-${mark}`;
await page.getByRole('textbox', { name: '修正指示' }).fill(INSTRUCTION);
await page.screenshot({ path: `${SP}/h01-edit-${mark}-dialog.png` });
await page.getByRole('button', { name: '修正を依頼' }).click();
await page.getByText(/ワンダが v2 を作成しました/).waitFor({ state: 'visible', timeout: 30000 });

const mockV2 = one(`select id from mocks where screen_name='${screen}' and version=2 and deleted_at is null`);
check(!!mockV2, '① 修正依頼 → 新バージョン v2 が DB に実在');
await page.waitForURL((u) => u.searchParams.get('mock') === mockV2, { timeout: 15000 });
check(
  one(`select meta_tags->>'author' from mocks where id='${mockV2}'`) === 'wanda' &&
    one(`select meta_tags->>'revision_instruction' from mocks where id='${mockV2}'`) === INSTRUCTION &&
    one(`select meta_tags->>'model' from mocks where id='${mockV2}'`) === 'fake-llm',
  '① meta_tags: author=wanda + 修正指示 + model 永続',
);
const v2Path = one(`select html_storage_path from mocks where id='${mockV2}'`);
const v2Html = readFileSync(`${SP}/storage-objects/${v2Path}`, 'utf8');
check(
  v2Path !== v1Path && v2Html.includes('data-fake-revision') && v2Html.includes(INSTRUCTION) && v2Html.includes('v1 original'),
  '① 改訂 HTML が storage に実在 (新パス + 指示バナー + 原文保持)',
);
check(
  one(`select parent_mock_id from mocks where id='${mockV2}'`) === mockV1,
  '① parent_mock_id 連鎖 (v2 → v1)',
);
check(
  one(`select count(*) from audit_logs where action='mock.version_create' and target_id='${mockV2}'`) === '1',
  '① audit mock.version_create',
);

// バージョンパネル: ワンダ（更新）+ 修正指示
await page.getByText('ワンダ（更新）').waitFor({ state: 'visible', timeout: 10000 });
check((await page.getByText(`修正指示: ${INSTRUCTION}`).count()) > 0, '① パネルに ワンダ（更新） + 修正指示 表示');
await page.screenshot({ path: `${SP}/h01-edit-${mark}-v2.png` });

// ② 複製 (v2 → v3、同一 HTML 参照)
await page.getByRole('button', { name: 'v2 を複製' }).click();
await page.getByText(/複製から v3 を作成しました/).waitFor({ state: 'visible', timeout: 15000 });
const mockV3 = one(`select id from mocks where screen_name='${screen}' and version=3 and deleted_at is null`);
check(
  !!mockV3 && one(`select html_storage_path from mocks where id='${mockV3}'`) === v2Path,
  '② 複製 → v3 実在 (同一 HTML 参照)',
);
await page.getByText('v2 の複製').waitFor({ state: 'visible', timeout: 10000 });
check(
  one(`select count(*) from audit_logs where action='mock.duplicate' and target_id='${mockV3}'`) === '1',
  '② audit mock.duplicate',
);
await page.screenshot({ path: `${SP}/h01-edit-${mark}-v3.png` });

// ③ 破棄 (2 段階確認): v3 を破棄
await page.getByRole('button', { name: 'v3 を破棄' }).click();
await page.getByText('v3 を破棄しますか？').waitFor({ state: 'visible', timeout: 5000 });
check(
  one(`select deleted_at is null from mocks where id='${mockV3}'`) === 't',
  '③ 確認段階では破棄されない (2 段階)',
);
await page.getByRole('button', { name: '破棄を確定' }).click();
await page.getByText(/バージョンを破棄しました/).waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select deleted_at is not null from mocks where id='${mockV3}'`) === 't',
  '③ 破棄確定 → soft delete (DB 突合)',
);
check(
  one(`select count(*) from audit_logs where action='mock.discard' and target_id='${mockV3}'`) === '1',
  '③ audit mock.discard',
);

// ③b 表示中バージョン (v2) を破棄 → 残存最新 v1 へ遷移
await page.getByRole('button', { name: 'v2 を破棄' }).click();
await page.getByRole('button', { name: '破棄を確定' }).click();
await page.waitForURL((u) => u.searchParams.get('mock') === mockV1, { timeout: 15000 });
check(
  one(`select deleted_at is not null from mocks where id='${mockV2}'`) === 't',
  '③b 表示中バージョン破棄 → 残存 v1 へ自動遷移',
);

// ④ 唯一版 (v1) の破棄は 409 → honest エラー
await page.getByRole('button', { name: 'v1 を破棄' }).click();
await page.getByRole('button', { name: '破棄を確定' }).click();
await page.getByText('唯一のバージョンは破棄できません。').waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select deleted_at is null from mocks where id='${mockV1}'`) === 't',
  '④ 唯一版は破棄されない (409 ガード)',
);
await page.screenshot({ path: `${SP}/h01-edit-${mark}-409.png` });

await browser.close();
sql(`delete from mocks where screen_name='${screen}'`);
execSync(`rm -rf ${SP}/storage-objects/mocks/h01edit-${mark}`);
const v2Dir = v2Path.split('/').slice(0, -1).join('/');
execSync(`rm -rf ${SP}/storage-objects/${v2Dir}`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/h01-edit-${mark}-*.png)`);
process.exit(failures === 0 ? 0 : 1);
