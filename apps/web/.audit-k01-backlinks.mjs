/**
 * GAP-012 ナレッジバックリンク実操作監査 (S-E01 チャット RAG 消費 → S-K01 逆引き)
 *
 * 実 UI で: ナレッジをシード → チャットで新規スレッド作成 → キーワード送信
 * (SSE stream 完走で knowledge_references が永続化される実経路) → DB 突合 →
 * 同スレッドで再送信 → reference_count=2 に畳まれる → S-K01 で対象ノードを
 * 選択 → バックリンク節にスレッド題名 +「チャット · チャット応答で参照（RAG）
 * · 2 回」が実描画されることを確認。終了時にシード削除 (再実行可能)。
 *
 * 前提: postgres / web :3100 / API :8000 (ATELIER_ALLOW_FAKE_LLM=1 — dev には
 * ANTHROPIC_API_KEY が無く、実 LLM の代わりにコード内蔵の fake stream で
 * assistant 応答を完走させる。参照記録は本番と同一のコードパス)。
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
const pid = one(`select id from projects where workspace_id='${wsId}' and deleted_at is null order by created_at limit 1`);
const kid = one(
  `insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md, tags) values ('${wsId}','workspace','common','tech','バックリンク監査-${mark}','gap012audit-${mark} keyword content','{tech}') returning id`,
);
check(!!wsId && !!pid && !!kid, `ナレッジシード (${kid.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

// S-E01: 新規スレッドを作り、ナレッジに hit するキーワードを実送信 (SSE 完走)
await page.goto(`http://localhost:3100/chat?project=${pid}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /新規スレッド/ }).click();
await page.waitForTimeout(800);
await page.locator('select').nth(1).selectOption({ index: 1 });
await page.getByRole('button', { name: 'スレッドを作成' }).click();
await page.waitForTimeout(2000);

const msg = `gap012audit-${mark}`;
await page.getByLabel('メッセージを入力').fill(msg);
await page.getByRole('button', { name: '送信' }).click();
// fake LLM の echo 応答が描画される = stream 完走 (assistant 永続化 + 参照記録済)
await page.getByText(`echo: ${msg}`).first().waitFor({ state: 'visible', timeout: 20000 });
check(true, 'チャット送信 → assistant 応答完走 (SSE)');

const tid = one(
  `select ct.id from chat_threads ct join chat_messages cm on cm.thread_id=ct.id where cm.content='${msg}' order by ct.created_at desc limit 1`,
);
const ref1 = sql(
  `select referrer_type || '|' || referrer_id || '|' || reference_count from knowledge_references where knowledge_id='${kid}'`,
);
check(ref1 === `chat_thread|${tid}|1`, `DB: knowledge_references 記録 (${ref1})`);

// 同スレッドで再送信 → 同一 (knowledge, referrer) は count++ に畳まれる
await page.getByLabel('メッセージを入力').fill(msg);
await page.getByRole('button', { name: '送信' }).click();
await page.waitForTimeout(4000);
const cnt = one(`select reference_count from knowledge_references where knowledge_id='${kid}'`);
const rows = one(`select count(*) from knowledge_references where knowledge_id='${kid}'`);
check(cnt === '2' && rows === '1', `DB: 再参照は 1 行のまま count=2 (rows=${rows}, count=${cnt})`);

// S-K01: 対象ノードを選択 → バックリンク節が実データで描画される
// (S-E01 の作成ダイアログに題名欄は無く title=null が実 UI の正規状態 →
//  service が「無題スレッド」に fallback して表示する)
const threadTitle = one(`select coalesce(title, '無題スレッド') from chat_threads where id='${tid}'`);
check(threadTitle.length > 0, `参照元スレッド題名解決 (${threadTitle})`);
await page.goto(`http://localhost:3100/knowledge?workspace=${wsId}`, { waitUntil: 'networkidle' });
const item = page.getByRole('treeitem', { name: `バックリンク監査-${mark}` });
await item.waitFor({ state: 'visible', timeout: 15000 });
await item.click();
const section = page.getByRole('region', { name: 'バックリンク' });
await section.waitFor({ state: 'visible', timeout: 15000 });
const sectionText = await section.innerText();
check(sectionText.includes('バックリンク（1）'), `バックリンク（1） 見出し描画`);
check(sectionText.includes(threadTitle), `参照元スレッド題名「${threadTitle}」描画`);
check(
  sectionText.includes('チャット · チャット応答で参照（RAG） · 2 回'),
  '種別・文脈・再参照回数 (2 回) 描画',
);
await page.screenshot({ path: `${SP}/k01-backlinks-${mark}.png` });

await browser.close();
// シード削除 (references は FK cascade)。スレッドは自作テストデータなので削除。
sql(`delete from knowledge_nodes where id='${kid}'`);
sql(`delete from chat_messages where thread_id='${tid}'`);
sql(`delete from chat_threads where id='${tid}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/k01-backlinks-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
