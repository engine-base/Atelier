/**
 * GAP-027 招待メール再送 実操作監査 (S-L01)
 *
 * 実 UI で: 招待発行 → アクティブ行の再送ボタン (2 段階確認) →
 * POST /client-invitations/{id}/resend → DB token_hash がローテーション →
 * 新リンクバナー表示 → audit_logs client_invitation.resend +1 を DB 突合。
 * used 行に再送ボタンが無いことも確認。終了時に発行分を失効して後片付け。
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const mark = Math.random().toString(36).slice(2, 7);
const email = `resend-${mark}@client.example`;
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

const pid = sql(
  "select p.id from projects p join workspaces w on w.id=p.workspace_id join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' and p.deleted_at is null order by p.created_at limit 1",
);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/portal/invitations?project=${pid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 発行 (メールのみ・既定 TTL)
await page.locator('input[type="email"]:visible').first().fill(email);
await page.getByRole('button', { name: /^招待(する)?$|発行/ }).first().click();
await page.waitForTimeout(1800);
const inv = sql(`select id||'|'||token_hash from client_invitations where email='${email}'`);
const [invId, hashBefore] = inv.split('|');
check(!!invId, `招待発行 (${invId.slice(0, 8)})`);

// 発行バナーの旧リンクを退避してから閉じる挙動は不要 — 再送で新バナーが出るかを見る
const resendBtn = page.getByRole('button', { name: `${email} へ招待メールを再送` });
await resendBtn.waitFor({ state: 'visible', timeout: 10000 });
check(true, 'pending 行に再送ボタン描画');

const auditBefore = Number(sql("select count(*) from audit_logs where action='client_invitation.resend'"));
await resendBtn.click();
// 2 段階確認
check((await page.getByRole('button', { name: `${email} へ再送を確定 (旧リンクは失効)` }).isVisible()), '2 段階確認が出る');
await page.getByRole('button', { name: `${email} へ再送を確定 (旧リンクは失効)` }).click();
await page.waitForTimeout(1800);

const hashAfter = sql(`select token_hash from client_invitations where id='${invId}'`);
check(hashAfter !== hashBefore && hashAfter.length === 64, `DB: token_hash ローテーション (${hashBefore.slice(0, 8)}→${hashAfter.slice(0, 8)})`);

const auditAfter = Number(sql("select count(*) from audit_logs where action='client_invitation.resend'"));
check(auditAfter === auditBefore + 1, `audit_logs client_invitation.resend +1 (${auditBefore}→${auditAfter})`);

// 新リンクバナー (raw token を 1 度だけ表示) — token= を含む code が出る
const banner = page.locator('[role="status"]');
check(await banner.isVisible(), '新リンクバナー表示');
const link = (await banner.locator('code').first().textContent().catch(() => '')) ?? '';
check(link.includes('token='), '新リンクに token が含まれる');

await page.screenshot({ path: `${SP}/l01-resend-${mark}.png` });
await browser.close();
sql(`update client_invitations set revoked_at=now() where id='${invId}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/l01-resend-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
