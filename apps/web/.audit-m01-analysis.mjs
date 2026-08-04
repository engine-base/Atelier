/**
 * GAP-015 議事録構造化解析 実操作監査 (S-M01)
 *
 * worker 産の result JSON (text + analysis) をローカル storage スタブに置き、
 * external_uploads に parsed 済み行をシード → S-M01 の履歴から開く →
 * 署名付き URL フロー (実 API コード) 経由で サマリー/話者/抽出要件/
 * アクションアイテム が実描画されることを検証。analysis_error 版の誠実表示も確認。
 *
 * 前提: storage スタブ (:8790) + API が ATELIER_SUPABASE_ADMIN_API_URL=http://127.0.0.1:8790 で稼働。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const uid = one("select id from users where email='design-audit@example.com'");

// worker 産スキーマの result JSON を 2 種 (解析あり / 解析エラー) スタブへ配置
mkdirSync(`${SP}/storage-objects/transcripts/results`, { recursive: true });
const okName = `analysis-ok-${mark}`;
const errName = `analysis-err-${mark}`;
writeFileSync(`${SP}/storage-objects/transcripts/results/${okName}.json`, JSON.stringify({
  text: `打合せ本文-${mark}: LP の要件を確認しました。`,
  analysis: {
    summary: `要約-${mark}: LP 制作の要件を確認し、納期 4 週間で合意した。`,
    speakers: [{ name: '田中', role: 'クライアント' }, { name: 'スティーブ', role: null }],
    requirements: [`要件-${mark}: トップ + 問い合わせの 2 ページ`, '納期 4 週間'],
    action_items: [{ title: `AI-${mark}: 見積ドラフト作成`, owner: 'ワンダ' }],
    model: 'claude-sonnet-4-6',
  },
}));
writeFileSync(`${SP}/storage-objects/transcripts/results/${errName}.json`, JSON.stringify({
  text: `未解析本文-${mark}`,
  analysis_error: 'llm_unconfigured',
}));
const ins = (name, path) =>
  one(
    `insert into external_uploads (project_id, uploaded_by_user_id, type, storage_path, file_name, file_size_bytes, mime_type, parsed_at, parse_result_path) ` +
      `values ('${pid}','${uid}','audio','meetings/${pid}/${name}.wav','${name}.wav',1000,'audio/wav', now(), 'transcripts/results/${path}.json') returning id`,
  );
const okId = ins(okName, okName);
const errId = ins(errName, errName);
check(!!okId && !!errId, `parsed 済み議事録 2 件シード (${okId.slice(0, 8)}, ${errId.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/meetings?project=${pid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 履歴から解析あり議事録を開く (署名 URL → スタブ配信 → 解析ブロック描画)
await page.getByText(`${okName}.wav`).first().click();
await page.getByText(`要約-${mark}`, { exact: false }).waitFor({ state: 'visible', timeout: 15000 });
check(true, 'サマリーが実描画 (署名 URL フロー経由)');
check(await page.getByText('田中').isVisible(), '話者 (田中) 描画');
check(await page.getByText(`要件-${mark}: トップ + 問い合わせの 2 ページ`).isVisible(), '抽出要件描画');
check(await page.getByText(`AI-${mark}: 見積ドラフト作成`).isVisible(), 'アクションアイテム描画');
check(await page.getByText('（ワンダ）').isVisible(), 'アクション担当描画');
await page.screenshot({ path: `${SP}/m01-analysis-${mark}.png` });

// 解析エラー版は誠実表示
await page.getByText(`${errName}.wav`).first().click();
await page.getByText(/構造化解析は未実行です/).waitFor({ state: 'visible', timeout: 15000 });
check(await page.getByText(/解析用 LLM が未設定の環境です/).isVisible(), 'analysis_error の誠実表示');
check(await page.getByText(`未解析本文-${mark}`).isVisible(), '本文自体は表示される (additive)');

await browser.close();
sql(`update external_uploads set deleted_at=now() where id in ('${okId}','${errId}')`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/m01-analysis-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
