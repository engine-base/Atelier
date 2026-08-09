/**
 * GAP-031① 「分岐」実操作監査 (S-E01)
 *
 * 実 UI で: 新規スレッド → メッセージ 2 往復 (fake LLM echo で assistant 永続化)
 * → 1 個目の assistant の「分岐」を実クリック → 分岐先スレッドへ遷移
 * (タイトル「分岐: …」、分岐点までの 2 件のみ表示) → DB 突合 (コピー 2 件・
 * parent 連鎖・先頭コピーの parent = 分岐元 assistant・元スレッド 4 件のまま・
 * audit chat_thread.branch)。終了時にシード削除 (再実行可能)。
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

// 新規スレッド + 2 往復 (fake LLM echo が assistant を永続化)
await page.goto(`http://localhost:3100/chat?project=${pid}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /新規スレッド/ }).click();
await page.waitForTimeout(800);
await page.locator('select').nth(1).selectOption({ index: 1 });
await page.getByRole('button', { name: 'スレッドを作成' }).click();
await page.waitForTimeout(2000);

const msg1 = `branch-one-${mark}`;
await page.getByLabel('メッセージを入力').fill(msg1);
await page.getByRole('button', { name: '送信' }).click();
await page.getByText(`echo: ${msg1}`).first().waitFor({ state: 'visible', timeout: 20000 });
const msg2 = `branch-two-${mark}`;
await page.getByLabel('メッセージを入力').fill(msg2);
await page.getByRole('button', { name: '送信' }).click();
await page.getByText(`echo: ${msg2}`).first().waitFor({ state: 'visible', timeout: 20000 });
await page.waitForTimeout(1500);

const tid = one(
  `select ct.id from chat_threads ct join chat_messages cm on cm.thread_id=ct.id where cm.content='${msg1}' order by ct.created_at desc limit 1`,
);
const srcAsst = one(
  `select id from chat_messages where thread_id='${tid}' and role='assistant' and content='echo: ${msg1}'`,
);
check(!!tid && !!srcAsst, `スレッド + 分岐元 assistant 特定 (${srcAsst.slice(0, 8)})`);

// 1 個目の assistant (echo: one) の分岐ボタンをクリック
const branchBtns = page.getByRole('button', { name: 'このメッセージから分岐' });
check((await branchBtns.count()) >= 2, `分岐ボタンが persisted assistant に描画 (${await branchBtns.count()} 個)`);
await branchBtns.first().click();
await page.waitForTimeout(2500);

// 分岐先スレッド (DB) と UI 表示
const newTid = one(
  `select target_id from audit_logs where action='chat_thread.branch' and after->>'source_message_id'='${srcAsst}' order by created_at desc limit 1`,
);
check(!!newTid && newTid !== tid, `audit chat_thread.branch → 分岐先 (${newTid.slice(0, 8)})`);
check(
  one(`select title from chat_threads where id='${newTid}'`).startsWith('分岐: '),
  'DB: 分岐先タイトル「分岐: …」',
);
const copied = sql(
  `select content from chat_messages where thread_id='${newTid}' order by created_at, id`,
).split('\n');
check(
  copied.length === 2 && copied[0] === msg1 && copied[1] === `echo: ${msg1}`,
  `DB: 分岐点までの 2 件のみコピー (${copied.length} 件)`,
);
const firstParent = one(
  `select parent_message_id from chat_messages where thread_id='${newTid}' order by created_at, id limit 1`,
);
check(firstParent === srcAsst, 'DB: 先頭コピーの parent = 分岐元 assistant (系譜ポインタ)');
const chain = one(
  `select count(*) from chat_messages c2 join chat_messages c1 on c1.id = c2.parent_message_id and c1.thread_id = c2.thread_id where c2.thread_id='${newTid}'`,
);
check(chain === '1', 'DB: コピー行が parent_message_id で連鎖');
check(
  one(`select count(*) from chat_messages where thread_id='${tid}'`) === '4',
  'DB: 元スレッドは不変 (4 件のまま)',
);

// UI: 分岐先へ遷移済み — 分岐点までの内容のみ表示 (two は無い)
check((await page.getByText(`echo: ${msg1}`).count()) > 0, 'UI: 分岐先に one の echo 表示');
check((await page.getByText(`echo: ${msg2}`).count()) === 0, 'UI: 分岐後の two は表示されない (分岐点まで)');
await page.screenshot({ path: `${SP}/e01-branch-${mark}.png` });

await browser.close();
sql(`delete from chat_messages where thread_id in ('${tid}','${newTid}')`);
sql(`delete from chat_threads where id in ('${tid}','${newTid}')`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/e01-branch-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
