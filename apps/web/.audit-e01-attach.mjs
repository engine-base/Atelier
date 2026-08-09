/**
 * GAP-001 実操作監査 (S-E01 チャット添付)
 *
 * 前提: postgres / API(:8000 — storage env 設定済 + ATELIER_ALLOW_FAKE_LLM=1) /
 * web(:3100) / storage スタブ ($SP/storage-stub.mjs) 稼働。
 *
 * 検証: 実 PDF を「添付」で選択 → pending チップ → 送信 → 署名付き URL へ実 PUT
 * (スタブに実バイト保存) → user message の attachments jsonb に永続 (DB 突合) →
 * メッセージに添付チップ実描画 → クリックで署名付き URL を新タブで開く →
 * 許可外ファイルは即時拒否。終了時にシード削除 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
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

// 実 PDF (最小構成) を生成
const pdfBytes = Buffer.from(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n`,
);
const pdfPath = `${SP}/attach-${mark}.pdf`;
writeFileSync(pdfPath, pdfBytes);
const exePath = `${SP}/attach-${mark}.exe`;
writeFileSync(exePath, 'MZ not really');

// 前回クラッシュ残留の掃除
sql("delete from chat_messages where thread_id in (select id from chat_threads where title like '添付監査-%')");
sql("delete from chat_threads where title like '添付監査-%'");

const uid = one("select id from users where email='design-audit@example.com'");
const pid = one(
  `select p.id from projects p join workspaces w on w.id=p.workspace_id where w.owner_user_id='${uid}' and p.deleted_at is null order by p.created_at limit 1`,
);
const emp = one(
  `select e.id from ai_employees e join projects p on p.workspace_id=e.workspace_id where p.id='${pid}' limit 1`,
);
const tid = one(
  `insert into chat_threads (project_id, ai_employee_id, title) values ('${pid}','${emp}','添付監査-${mark}') returning id`,
);
check(!!tid, `シード完了 (thread ${tid.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/chat?thread=${tid}`, { waitUntil: 'networkidle' });

// 添付 → pending チップ
await page.getByRole('button', { name: '添付', exact: true }).waitFor({ state: 'visible', timeout: 20000 });
check(true, '「添付」ボタン実描画 (モック composer-tool 復元)');
await page.locator('input[aria-label="添付ファイルを選択"]').setInputFiles(pdfPath);
await page.getByText(`attach-${mark}.pdf`).first().waitFor({ state: 'visible', timeout: 10000 });
check(true, '送信前チップ実描画 (ファイル名 + サイズ)');

// 送信 → fake LLM echo 待ち
const msg = `この添付を確認して-${mark}`;
await page.getByLabel('メッセージを入力').fill(msg);
await page.getByRole('button', { name: '送信' }).click();
await page.getByText(`echo: ${msg}`).waitFor({ state: 'visible', timeout: 30000 });

// DB 突合: user message に attachments jsonb 永続
const att = one(
  `select attachments->0->>'storage_path' from chat_messages where thread_id='${tid}' and role='user' order by created_at limit 1`,
);
check(
  att.startsWith(`chat-attachments/${tid}/`) && att.endsWith(`attach-${mark}.pdf`),
  `DB: attachments jsonb 永続 (${att})`,
);
const stored = `${SP}/storage-objects/${att}`;
check(
  existsSync(stored) && statSync(stored).size === pdfBytes.length,
  'storage: 実バイトが PUT 保存されている (サイズ一致)',
);

// メッセージの添付チップ → クリックで署名付き URL を解決して開く
// (PDF はブラウザがダウンロード扱いにするため、URL 解決 API の実応答 +
//  署名付き URL の実 GET でバイト一致まで突合する)
const chip = page.getByRole('button', { name: `添付を開く: attach-${mark}.pdf` });
await chip.waitFor({ state: 'visible', timeout: 15000 });
const [urlRes] = await Promise.all([
  page.waitForResponse((r) => r.url().includes('/attachments/0/url') && r.status() === 200, {
    timeout: 15000,
  }),
  chip.click(),
]);
const signedUrl = (await urlRes.json())?.data?.url ?? '';
check(
  signedUrl.includes('/object/download/chat-attachments/'),
  `添付チップ → 署名付き URL 実解決 (${signedUrl.slice(0, 70)}…)`,
);
const dl = await page.request.get(signedUrl);
check(
  dl.ok() && (await dl.body()).length === pdfBytes.length,
  '署名付き URL の実 GET でバイト一致 (実ダウンロード成立)',
);
await page.screenshot({ path: `${SP}/e01-attach-${mark}.png` });

// 許可外ファイルは即時拒否 (upload API を呼ばない誠実表示)
await page.locator('input[aria-label="添付ファイルを選択"]').setInputFiles(exePath);
check(
  (await page.getByText('対応していないファイル形式です (画像 / PDF / テキスト / CSV / ZIP のみ)。').count()) > 0,
  '許可外ファイルは即時 inline error',
);

await browser.close();
sql(`delete from chat_messages where thread_id='${tid}'`);
sql(`delete from chat_threads where id='${tid}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/e01-attach-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
