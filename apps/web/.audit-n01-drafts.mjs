/**
 * GAP-018 実操作監査 (S-N01 商談ドラフトの未実装機能群)
 *
 * 検証: ① doc_type 5 タブ (提案/見積/業務委託契約/NDA/請求書 — 実件数バッジ)
 * ② AI 生成 = トニーへの依頼 (明示操作) → ナレッジ RAG → 生成トレース
 * (生成プロセス実工程 + 参照ナレッジ実表示 + meta/knowledge_references DB 突合)
 * ③ PDF 実バイナリ DL (%PDF- 突合) ④ メール送信ダイアログ → dry_run 正直表示 +
 * 送信履歴実描画 (sales_doc_sends DB 突合) ⑤ audit 証跡。
 * 専用プロジェクトをシードし終了時に削除 (再実行可能)。
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
sql("delete from projects where name like 'N01監査-%'");
sql("delete from knowledge_nodes where title like 'N01監査テンプレ-%'");

const uid = one("select id from users where email='design-audit@example.com'");
const ws = one(`select id from workspaces where owner_user_id='${uid}' order by created_at limit 1`);

const proj = one(
  `insert into projects (workspace_id, name, project_type) values ('${ws}','N01監査-${mark}','client_work') returning id`,
);
const kn = one(
  `insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md) values ('${ws}','workspace','common','sales','N01監査テンプレ-${mark} 提案書','# 過去成約パターン 成約率 +18%') returning id`,
);
check(!!proj && !!kn, `シード完了 (project ${proj.slice(0, 8)} + 実ナレッジ)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await ctx.newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

await page.goto(`http://localhost:3100/sales?project=${proj}`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: '提案 / 見積 / 契約 / 請求書ドラフト' }).waitFor({ state: 'visible', timeout: 20000 });

// ① 5 タブ実描画
for (const label of ['提案書', '見積書', '業務委託契約', 'NDA', '請求書']) {
  check((await page.getByRole('tab', { name: new RegExp(label) }).count()) === 1, `① タブ ${label} 実描画`);
}

// ② AI 生成 (トニー + ナレッジ RAG)
await page.getByLabel(/顧客名/).fill('ENGINE BASE 株式会社');
await page.getByLabel('案件', { exact: false }).first().fill(`提案書テンプレ活用-${mark}`);
await page.getByLabel(/商談概要/).fill('過去の成約パターンを踏まえた提案書を作りたい。予算感と体制も整理したい。');
await page.getByRole('button', { name: 'トニーにドラフト生成を依頼' }).click();
await page.getByText(/トニーが提案書 v1 を生成しました（ナレッジ参照 \d+ 件）/).waitFor({ state: 'visible', timeout: 30000 });
const doc1 = one(`select id from workflow_outputs where project_id='${proj}' and stage='proposal' and deleted_at is null`);
check(!!doc1, '② 生成ドラフトが DB 実在 (stage=proposal)');
check(
  one(`select meta->>'generated_by' from workflow_outputs where id='${doc1}'`) === 'tony' &&
    one(`select meta->>'model' from workflow_outputs where id='${doc1}'`) === 'fake-llm',
  '② meta 生成トレース (generated_by=tony / model) 永続',
);
check(
  one(`select count(*) from knowledge_references where referrer_type='sales_doc' and referrer_id='${doc1}' and knowledge_id='${kn}'`) === '1',
  '② 参照ナレッジが knowledge_references に実記録',
);
check((await page.getByText(/\[fake LLM\] 商談概要/).count()) > 0, '② プレビューに生成本文実描画');
// 生成プロセス = 実工程 / 参照ナレッジ = 実タイトル
check((await page.getByText(/ナレッジ参照 \(\d+ 件\)/).count()) > 0, '② 生成プロセスに実工程表示');
check((await page.getByText(`N01監査テンプレ-${mark} 提案書`).count()) > 0, '② 参照ナレッジカードに実ナレッジ表示');
check((await page.getByText('（参考手順）').count()) === 0, '② トレースあり → 参考手順表記なし');
await page.screenshot({ path: `${SP}/n01-${mark}-generated.png` });

// ① 新 doc_type: 業務委託契約タブで生成 → contract 行
await page.getByRole('tab', { name: /業務委託契約/ }).click();
await page.getByLabel(/顧客名/).fill('ENGINE BASE 株式会社');
await page.getByLabel('案件', { exact: false }).first().fill(`業務委託契約-${mark}`);
await page.getByLabel(/商談概要/).fill('受託開発の業務委託契約ドラフトを作成したい。');
await page.getByRole('button', { name: 'トニーにドラフト生成を依頼' }).click();
await page.getByText(/トニーが業務委託契約 v1 を生成しました/).waitFor({ state: 'visible', timeout: 30000 });
check(
  one(`select count(*) from workflow_outputs where project_id='${proj}' and stage='contract' and deleted_at is null`) === '1',
  '① contract ドキュメントが DB 実在 (enum 拡張)',
);
check((await page.getByRole('tab', { name: /業務委託契約/ }).textContent())?.includes('1') === true, '① タブ件数バッジ実更新');

// ③ PDF 実バイナリ DL
const dlPromise = page.waitForEvent('download', { timeout: 20000 });
await page.getByRole('button', { name: 'PDF', exact: true }).click();
const dl = await dlPromise;
const pdfPath = `${SP}/n01-${mark}.pdf`;
await dl.saveAs(pdfPath);
const head = readFileSync(pdfPath).subarray(0, 5).toString('latin1');
check(head === '%PDF-', `③ PDF 実バイナリ DL (${head})`);

// ④ メール送信 (dry_run 正直表示) + 送信履歴
await page.getByRole('button', { name: '送信', exact: true }).click();
await page.getByRole('dialog', { name: 'クライアントにメール送信' }).waitFor({ state: 'visible', timeout: 5000 });
await page.getByPlaceholder('client@example.com').fill(`n01-${mark}@example.com`);
await page.getByLabel(/挨拶文/).fill('ドラフトをご確認ください。');
await page.getByRole('button', { name: '送信する' }).click();
await page.getByText(/dry-run/).first().waitFor({ state: 'visible', timeout: 20000 });
const contractDoc = one(`select id from workflow_outputs where project_id='${proj}' and stage='contract'`);
check(
  one(`select to_email || '|' || dry_run from sales_doc_sends where doc_id='${contractDoc}'`) === `n01-${mark}@example.com|true`,
  '④ 送信履歴 DB 実在 (dry_run=t を偽装せず記録)',
);
await page.getByText(`n01-${mark}@example.com`).first().waitFor({ state: 'visible', timeout: 15000 });
check((await page.getByText('dry-run（メール未設定）').count()) > 0, '④ 送信履歴カードに dry-run 明示');
check((await page.getByText('まだ送信されていません').count()) === 0, '④ 履歴ありで空表示は消える');
await page.screenshot({ path: `${SP}/n01-${mark}-send.png` });

// ⑤ audit 証跡
check(
  one(`select count(*) from audit_logs where action='sales_doc.generate' and target_id in ('${doc1}','${contractDoc}')`) === '2',
  '⑤ audit sales_doc.generate ×2',
);
check(
  one(`select count(*) from audit_logs where action='sales_doc.send' and target_id='${contractDoc}'`) === '1',
  '⑤ audit sales_doc.send ×1',
);

await browser.close();
sql(`delete from projects where id='${proj}'`);
sql(`delete from knowledge_nodes where id='${kn}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/n01-${mark}-*.png)`);
process.exit(failures === 0 ? 0 : 1);
