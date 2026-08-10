/**
 * GAP-023 実操作監査 (S-G01 成果物ビューアの未対応要素群)
 *
 * 検証: ① format タブ (HTML/MD 実在分のみ・MD 実テキスト描画) ② コメント対象位置
 * (anchors 実抽出 → 投稿 target_element_id → チップ + 本文へ = #fragment ジャンプ)
 * ③ スレッド返信 (parent_comment_id) ④ AI 修正提案 — 依頼 → pending (ai-fix
 * ブロック) → 却下 = 文書不変 / 承認 = 新バージョン適用 + 遷移 (DB/storage 突合)
 * ⑤ 「編集」= スティーブへの修正依頼 → 新バージョン ⑥ バージョン選択 (実 select +
 * スティーブ（更新） 表示 + 遷移)。終了時にシード削除 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
sql("delete from output_fix_proposals where output_id in (select id from workflow_outputs where summary like 'G01監査-%')");
sql("delete from comments where target_type='workflow_output' and target_id in (select id from workflow_outputs where summary like 'G01監査-%')");
sql("delete from workflow_outputs where summary like 'G01監査-%'");

const uid = one("select id from users where email='design-audit@example.com'");
const proj = one(
  `select p.id from projects p join workspaces w on w.id=p.workspace_id where w.owner_user_id='${uid}' and p.deleted_at is null order by p.created_at limit 1`,
);

// シード: v1 の実 HTML (anchors 付き) + MD を storage スタブ実体に配置 + 行
const dir = `outputs/g01audit-${mark}`;
mkdirSync(`${SP}/storage-objects/${dir}`, { recursive: true });
writeFileSync(
  `${SP}/storage-objects/${dir}/v1.html`,
  `<!doctype html><html><head><title>G01監査-${mark}</title></head><body>
<h2 id="sec-1">1. プロジェクト概要</h2><p>AI 社員が常駐する SaaS を構築する。</p>
<h2 id="sec-2">2. 成功の定義</h2><p>2026 年内 100 社。</p>
</body></html>`,
);
writeFileSync(`${SP}/storage-objects/${dir}/v1.md`, `# G01監査-${mark}\n\n- md 実体`);
const out1 = one(
  `insert into workflow_outputs (project_id, stage, summary, html_path, md_path, version) values ('${proj}','requirements','G01監査-${mark}','${dir}/v1.html','${dir}/v1.md',1) returning id`,
);
check(!!out1, `シード完了 (output v1 ${out1.slice(0, 8)} + storage 実体 html/md)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

await page.goto(`http://localhost:3100/outputs?output=${out1}`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: `G01監査-${mark}` }).waitFor({ state: 'visible', timeout: 20000 });

// ① format タブ: 実在分のみ (JSON は無い)
check((await page.getByRole('tab', { name: 'HTML' }).count()) === 1, '① HTML タブ描画');
check((await page.getByRole('tab', { name: 'MD' }).count()) === 1, '① MD タブ描画 (md_path 実在)');
check((await page.getByRole('tab', { name: 'JSON' }).count()) === 0, '① JSON タブ非描画 (未生成 — Rule 10)');
await page.getByRole('tab', { name: 'MD' }).click();
await page.getByText('- md 実体').waitFor({ state: 'visible', timeout: 15000 });
check(true, '① MD タブで実テキスト描画 (署名 URL → fetch)');
await page.getByRole('tab', { name: 'HTML' }).click();

// ② コメント対象位置: anchors 実抽出 → 投稿 → チップ + 本文へジャンプ
await page.getByRole('combobox', { name: 'コメント対象位置' }).selectOption('sec-2');
await page.getByPlaceholder('選択箇所にコメント...').fill(`内訳を分けてほしい-${mark}`);
await page.getByRole('button', { name: '投稿' }).click();
await page.getByText(`内訳を分けてほしい-${mark}`).waitFor({ state: 'visible', timeout: 15000 });
const c1 = one(
  `select id from comments where target_type='workflow_output' and target_id='${out1}' and content like '内訳%${mark}'`,
);
check(
  one(`select target_element_id from comments where id='${c1}'`) === 'sec-2',
  '② target_element_id=sec-2 が DB 永続',
);
const card1 = page.locator('li').filter({ hasText: `内訳を分けてほしい-${mark}` }).first();
check((await card1.getByText('2. 成功の定義').count()) > 0, '② チップに anchors 実ラベル表示');
await card1.getByRole('button', { name: '本文へ →' }).click();
const frameSrc = await page.locator('iframe').first().getAttribute('src');
check(frameSrc !== null && frameSrc.endsWith('#sec-2'), '② 本文へ → iframe が #sec-2 フラグメントへ');
await page.screenshot({ path: `${SP}/g01-${mark}-comment.png` });

// ③ スレッド返信 (parent_comment_id)
await card1.getByRole('button', { name: '返信' }).click();
await card1.getByPlaceholder('返信を入力…').fill(`了解です-${mark}`);
await card1.getByRole('button', { name: '返信する' }).click();
await page.getByText(`了解です-${mark}`).waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select parent_comment_id from comments where content='了解です-${mark}'`) === c1,
  '③ 返信が parent_comment_id 付きで DB 永続',
);

// ④a 依頼 → pending → 却下 (文書不変)
const rejCard = page.locator('li').filter({ hasText: `内訳を分けてほしい-${mark}` }).first();
await rejCard.getByRole('button', { name: 'スティーブに修正提案を依頼' }).click();
await page.getByText('スティーブの修正提案：').waitFor({ state: 'visible', timeout: 20000 });
const p1 = one(`select id from output_fix_proposals where comment_id='${c1}'`);
check(
  one(`select status from output_fix_proposals where id='${p1}'`) === 'pending',
  '④ 依頼 → pending 提案が DB 実在 (自動生成なし)',
);
await page.screenshot({ path: `${SP}/g01-${mark}-proposal.png` });
const versionsBefore = one(`select count(*) from workflow_outputs where summary='G01監査-${mark}' and deleted_at is null`);
await rejCard.getByRole('button', { name: '却下' }).click();
await page.getByText('提案を却下しました（文書は変更されていません）。').waitFor({ state: 'visible', timeout: 15000 });
check(
  one(`select status from output_fix_proposals where id='${p1}'`) === 'rejected' &&
    one(`select count(*) from workflow_outputs where summary='G01監査-${mark}' and deleted_at is null`) === versionsBefore,
  '④ 却下 → rejected + 文書不変 (バージョン数不変)',
);
check((await rejCard.getByText('却下済み（文書は変更されていません）').count()) > 0, '④ 却下済み表示');

// ④b 別コメントで 依頼 → 承認 = 新バージョン適用 + 遷移
await page.getByPlaceholder('選択箇所にコメント...').fill(`可視範囲を明示して-${mark}`);
await page.getByRole('button', { name: '投稿' }).click();
const apCard = page.locator('li').filter({ hasText: `可視範囲を明示して-${mark}` }).first();
await apCard.getByRole('button', { name: 'スティーブに修正提案を依頼' }).click();
await apCard.getByText('スティーブの修正提案：').waitFor({ state: 'visible', timeout: 20000 });
await apCard.getByRole('button', { name: '承認' }).click();
await page.getByText(/提案を承認し、スティーブが v2 を作成しました/).waitFor({ state: 'visible', timeout: 30000 });
const out2 = one(`select id from workflow_outputs where summary='G01監査-${mark}' and version=2 and deleted_at is null`);
check(!!out2, '④ 承認 → 新バージョン v2 が DB 実在');
await page.waitForURL((u) => u.searchParams.get('output') === out2, { timeout: 15000 });
const c2 = one(`select id from comments where content='可視範囲を明示して-${mark}'`);
const p2 = one(`select id from output_fix_proposals where comment_id='${c2}'`);
check(
  one(`select status || '|' || applied_output_id from output_fix_proposals where id='${p2}'`) === `approved|${out2}`,
  '④ approved + applied_output_id 突合',
);
const v2Path = one(`select html_path from workflow_outputs where id='${out2}'`);
const v2Html = readFileSync(`${SP}/storage-objects/${v2Path}`, 'utf8');
check(
  v2Html.includes('data-fake-revision') && v2Html.includes(`可視範囲を明示して-${mark}`),
  '④ 改訂 HTML が storage に実在 (提案文が修正指示として適用)',
);
check(
  one(`select meta->>'author' from workflow_outputs where id='${out2}'`) === 'steve',
  '④ meta author=steve 永続',
);

// ⑥ バージョン選択: v2 表示中、select に スティーブ（更新）、v1 へ遷移
await page.getByRole('heading', { name: `G01監査-${mark}` }).waitFor({ state: 'visible', timeout: 20000 });
const select = page.getByRole('combobox', { name: 'バージョン選択' });
check((await select.textContent())?.includes('スティーブ（更新）') === true, '⑥ バージョン select に スティーブ（更新）');
check((await page.getByRole('tab', { name: 'MD' }).count()) === 0, '⑥ v2 は MD 未生成 → MD タブ非描画 (旧版偽装しない)');
await page.screenshot({ path: `${SP}/g01-${mark}-v2.png` });

// ⑤ 「編集」= スティーブへの修正依頼 → v3
await page.getByRole('button', { name: '編集' }).click();
await page.getByRole('dialog', { name: 'スティーブに修正を依頼' }).waitFor({ state: 'visible', timeout: 5000 });
const INSTRUCTION = `2.5 項に可視範囲サブセクションを追加-${mark}`;
await page.getByRole('textbox', { name: '修正指示' }).fill(INSTRUCTION);
await page.getByRole('button', { name: '修正を依頼' }).click();
await page.getByText(/スティーブが v3 を作成しました/).waitFor({ state: 'visible', timeout: 30000 });
const out3 = one(`select id from workflow_outputs where summary='G01監査-${mark}' and version=3 and deleted_at is null`);
check(!!out3, '⑤ 編集 (修正依頼) → v3 が DB 実在');
await page.waitForURL((u) => u.searchParams.get('output') === out3, { timeout: 15000 });
const v3Html = readFileSync(`${SP}/storage-objects/${one(`select html_path from workflow_outputs where id='${out3}'`)}`, 'utf8');
check(
  v3Html.includes(INSTRUCTION) &&
    one(`select meta->>'revision_instruction' from workflow_outputs where id='${out3}'`) === INSTRUCTION,
  '⑤ 指示が storage バナー + meta に実在',
);

// ⑥b v1 へ戻る遷移
await page.getByRole('combobox', { name: 'バージョン選択' }).selectOption(out1);
await page.waitForURL((u) => u.searchParams.get('output') === out1, { timeout: 15000 });
check(true, '⑥ バージョン選択で v1 へ実遷移');
await page.screenshot({ path: `${SP}/g01-${mark}-v1back.png` });

// audit 突合
check(
  one(
    `select count(*) from audit_logs where action in ('output.revise','output.fix_proposal.propose','output.fix_proposal.approve','output.fix_proposal.reject') and target_id in ('${out1}','${out2}','${out3}')`,
  ) === '5',
  'audit 5 行 (propose×2 / reject / approve / revise)',
);

await browser.close();
sql(`delete from output_fix_proposals where output_id in (select id from workflow_outputs where summary='G01監査-${mark}')`);
sql(`delete from comments where target_type='workflow_output' and target_id in (select id from workflow_outputs where summary='G01監査-${mark}')`);
sql(`delete from workflow_outputs where summary='G01監査-${mark}'`);
execSync(`rm -rf ${SP}/storage-objects/${dir}`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/g01-${mark}-*.png)`);
process.exit(failures === 0 ? 0 : 1);
