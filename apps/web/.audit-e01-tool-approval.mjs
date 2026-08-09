/**
 * GAP-031① 「承認して実行」実操作監査 (S-E01 ツール実行の人間承認)
 *
 * シード: スレッド + request_tool_approval と同形の pending 承認 ×2
 * (dev は LLM 無しでツール要求が発生しないため、登録側は pytest で担保 —
 *  承認/実行/差戻side は本監査で実 UI E2E)。
 * 検証: 承認カード実描画 (タイトル/Inbox リンク) → 「承認して実行」→
 * 実 knowledge 生成 (DB 突合) + inbox approved + スレッドに tool メッセージ
 * 実描画 → カード消滅 → 2 個目を「差戻」→ rejected + system メッセージ +
 * knowledge は生まれない。終了時にシード削除 (再実行可能)。
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

const uid = one("select id from users where email='design-audit@example.com'");
const pid = one(
  `select p.id from projects p join workspaces w on w.id=p.workspace_id where w.owner_user_id='${uid}' and p.deleted_at is null order by p.created_at limit 1`,
);
const emp = one(
  `select e.id from ai_employees e join projects p on p.workspace_id=e.workspace_id where p.id='${pid}' limit 1`,
);
const tid = one(
  `insert into chat_threads (project_id, ai_employee_id, title) values ('${pid}','${emp}','承認監査-${mark}') returning id`,
);
sql(`insert into chat_messages (thread_id, role, content, created_at) values ('${tid}','user','成果物を保存して', clock_timestamp())`);

const titleA = `承認成果物A-${mark}`;
const titleB = `承認成果物B-${mark}`;
const seedApproval = (title) =>
  one(
    `insert into approval_inbox (user_id, type, target_type, target_id, title, payload) values ('${uid}','tool_execution','chat_thread','${tid}','ツール実行の承認: save_deliverable（${title}）', jsonb_build_object('tool','save_deliverable','tool_input', jsonb_build_object('title','${title}','category','要件定義','content_md','# ${title}'), 'thread_id','${tid}')) returning id`,
  );
const apA = seedApproval(titleA);
const apB = seedApproval(titleB);
check(!!tid && !!apA && !!apB, `シード完了 (thread ${tid.slice(0, 8)} / 承認 ×2)`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/chat?thread=${tid}`, { waitUntil: 'networkidle' });

// 承認カード実描画 (2 枚)
const cardHeads = page.getByText('承認が必要：ツールの実行を進めてよいですか？');
await cardHeads.first().waitFor({ state: 'visible', timeout: 20000 });
check((await cardHeads.count()) === 2, `承認カード 2 枚描画`);
check((await page.getByText(titleA).count()) > 0, `カードに tool_input タイトル表示 (${titleA})`);
check(
  (await page.getByRole('link', { name: 'Inbox で確認' }).first().getAttribute('href')) === '/approvals',
  'Inbox で確認 → /approvals 実リンク',
);

// 承認して実行 (1 枚目) → 実 knowledge 生成 + tool メッセージ
await page.getByRole('button', { name: '承認して実行' }).first().click();
await page.waitForTimeout(2500);
check(
  one(`select count(*) from knowledge_nodes where title='${titleA}'`) === '1',
  'DB: 承認で実 knowledge 生成 (save_deliverable 実実行)',
);
check(
  one(`select status from approval_inbox where id='${apA}'`) === 'approved',
  'DB: inbox approved + 実行結果を resolution_note に記録',
);
check((await page.getByText('save_deliverable').count()) > 0, 'スレッドに tool メッセージ実描画');
check((await cardHeads.count()) === 1, '実行済みカードは消滅 (残 1 枚)');

// 差戻 (2 枚目) → rejected + system メッセージ + knowledge は生まれない
await page.getByRole('button', { name: '差戻' }).click();
await page.waitForTimeout(2000);
check(
  one(`select status from approval_inbox where id='${apB}'`) === 'rejected',
  'DB: 差戻で rejected',
);
check(
  one(`select count(*) from knowledge_nodes where title='${titleB}'`) === '0',
  'DB: 差戻は実行されない (knowledge 0 件)',
);
check(
  (await page.getByText('ツール実行「save_deliverable」は差し戻されました。').count()) > 0,
  'スレッドに差戻 system メッセージ実描画',
);
check((await cardHeads.count()) === 0, '全カード消滅');
await page.screenshot({ path: `${SP}/e01-tool-approval-${mark}.png` });

await browser.close();
sql(`delete from knowledge_nodes where title='${titleA}'`);
sql(`delete from approval_inbox where id in ('${apA}','${apB}')`);
sql(`delete from chat_messages where thread_id='${tid}'`);
sql(`delete from chat_threads where id='${tid}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/e01-tool-approval-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
