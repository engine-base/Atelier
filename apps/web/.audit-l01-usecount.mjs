/**
 * GAP-027② 招待使用回数 実操作監査 (S-L01 発行 → S-L02 ポータルサインイン ×2 → 使用回数列)
 *
 * 実 UI で: S-L01 で招待発行 → バナーの招待リンク (raw token) を取得 →
 * 別コンテキスト (クライアント本人) で S-L02 から同意してサインイン → もう一度
 * 別コンテキストでサインイン (リンク再利用) → DB client_invitations.use_count=2
 * 突合 → S-L01 リロードで「使用回数」列に「2 回」実描画。終了時にシード削除。
 *
 * 前提: postgres / API :8000 / web :3100 稼働。
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
const email = `usecount-${mark}@client.example`;
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

const pid = one(
  "select p.id from projects p join workspaces w on w.id=p.workspace_id join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' and p.deleted_at is null order by p.created_at limit 1",
);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const owner = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await owner.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await owner.getByLabel(/メール/).fill('design-audit@example.com');
await owner.locator('input[type="password"]').first().fill('Passw0rd!123');
await owner.getByRole('button', { name: 'サインイン' }).click();
await owner.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await owner.goto(`http://localhost:3100/portal/invitations?project=${pid}`, { waitUntil: 'networkidle' });
await owner.waitForTimeout(1200);

// 発行 → バナーから招待リンク (raw token) を取得
await owner.locator('input[type="email"]:visible').first().fill(email);
await owner.getByRole('button', { name: /招待を発行/ }).first().click();
await owner.waitForTimeout(1800);
const invId = one(`select id from client_invitations where email='${email}'`);
check(!!invId, `招待発行 (${invId.slice(0, 8)})`);
const banner = owner.locator('[role="status"]');
const link = ((await banner.locator('code').first().textContent().catch(() => '')) ?? '').trim();
check(link.includes('token='), `発行バナーに招待リンク (${link.slice(0, 48)}…)`);

// クライアント本人としてポータルサインイン (別コンテキスト) — 2 回
for (const round of [1, 2]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const client = await ctx.newPage();
  await client.goto(link, { waitUntil: 'networkidle' });
  // token は URL クエリから自動展開される。同意 2 種にチェックしてサインイン
  const boxes = client.locator('input[type="checkbox"]');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await client.getByRole('button', { name: '同意してサインイン' }).click();
  await client.waitForURL((u) => u.pathname.startsWith('/portal') && !u.pathname.includes('signin'), {
    timeout: 20000,
  });
  check(true, `ポータルサインイン成功 (${round} 回目 → ${new URL(client.url()).pathname})`);
  await ctx.close();
}

// DB 突合: use_count=2 / used_at 記録
const row = one(`select use_count || '|' || (used_at is not null) from client_invitations where id='${invId}'`);
check(row === '2|true', `DB: use_count=2 + used_at 記録 (${row})`);

// S-L01 リロード → 「使用回数」列に 2 回
await owner.goto(`http://localhost:3100/portal/invitations?project=${pid}`, { waitUntil: 'networkidle' });
await owner.waitForTimeout(1500);
const tr = owner.locator('tr', { hasText: email });
await tr.first().waitFor({ state: 'visible', timeout: 15000 });
const rowText = await tr.first().innerText();
check(rowText.includes('2 回'), `S-L01 行に「2 回」実描画`);
check((await owner.getByRole('columnheader', { name: '使用回数' }).count()) >= 1, '「使用回数」列見出し描画');
await owner.screenshot({ path: `${SP}/l01-usecount-${mark}.png` });

await browser.close();
sql(`delete from client_invitations where id='${invId}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/l01-usecount-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
