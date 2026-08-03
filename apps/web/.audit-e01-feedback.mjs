/**
 * S-E01 メッセージフィードバック実操作監査 (GAP-031 ① 役立った)
 *
 * 実 UI で: スレッド作成 → メッセージ送信 (SSE) → stream 後の実 ID 載せ替え
 * → 「役立った」クリック → audit_logs (chat_message.feedback) を DB 突合
 * → 「コピー」ボタン存在確認。再実行可能 (毎回新スレッド)。
 *
 * 前提: postgres / API :8000 / web :3100 稼働、audit token ($SP/token.txt or 再サインイン)。
 *   node .audit-e01-feedback.mjs
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const mark = Math.random().toString(36).slice(2, 7);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// サインイン (design-audit ユーザー)
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

// 最初のプロジェクトのチャットへ
const pid = sql(
  "select p.id from projects p join workspaces w on w.id=p.workspace_id join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' and p.deleted_at is null order by p.created_at limit 1",
);
check(!!pid, `対象プロジェクト取得 (${pid.slice(0, 8)})`);
await page.goto(`http://localhost:3100/chat?project=${pid}`, { waitUntil: 'networkidle' });

// 新規スレッド作成
await page.getByRole('button', { name: /新規スレッド/ }).click();
await page.waitForTimeout(800);
await page.locator('select').nth(1).selectOption({ index: 1 });
await page.getByRole('button', { name: 'スレッドを作成' }).click();
await page.waitForTimeout(2000);

// メッセージ送信 → user 行が永続化される
const text = `feedback-audit-${mark}`;
await page.getByLabel('メッセージを入力').fill(text);
await page.getByRole('button', { name: '送信' }).click();
await page.waitForTimeout(2500);

// dev は LLM key 無しで assistant 応答が生成されないため、実運用と同じ
// 「履歴ロード経路」を検証すべく assistant 行を同スレッドへシードする
// (自作テストデータ。role/thread は実スキーマ準拠)。
const tid = sql(
  `select ct.id from chat_threads ct join chat_messages cm on cm.thread_id=ct.id where cm.content='${text}' order by ct.created_at desc limit 1`,
);
check(!!tid, `スレッド特定 (${tid.slice(0, 8)}) — user 発話が永続化済み`);
sql(
  `insert into chat_messages (thread_id, role, content) values (cast('${tid}' as uuid),'assistant','了解しました。要件を整理します。(${mark})')`,
);
await page.goto(`http://localhost:3100/chat?thread=${tid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 履歴ロード (persisted) → 役立った/コピー が出る
const fbBtn = page.getByRole('button', { name: /フィードバック: 役立った/ }).last();
await fbBtn.waitFor({ state: 'visible', timeout: 20000 });
check(true, 'stream 後に 役立った ボタン描画 (実 ID 載せ替え)');
check(await page.getByRole('button', { name: 'メッセージをコピー' }).last().isVisible(), 'コピー ボタン描画');

const before = Number(sql("select count(*) from audit_logs where action='chat_message.feedback'"));
await fbBtn.click();
await page.getByText('役立った ✓').last().waitFor({ state: 'visible', timeout: 10000 });
check(true, 'クリック → 済表示 (役立った ✓ / disabled)');

const after = Number(sql("select count(*) from audit_logs where action='chat_message.feedback'"));
check(after === before + 1, `audit_logs chat_message.feedback +1 (${before}→${after})`);

// 突合: 対象 message は今回スレッドの assistant 実 ID
const lastFb = sql(
  "select cm.role from audit_logs al join chat_messages cm on cm.id = al.target_id where al.action='chat_message.feedback' order by al.created_at desc limit 1",
);
check(lastFb === 'assistant', `feedback 対象が assistant 実メッセージ (role=${lastFb})`);

await page.screenshot({ path: `${SP}/e01-feedback-${mark}.png`, fullPage: false });
await browser.close();
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/e01-feedback-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
