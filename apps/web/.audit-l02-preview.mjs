/**
 * GAP-028 実操作監査 (S-L02 招待プレビュー + 同意永続)
 *
 * シード: design-audit のプロジェクトに client_invitation (残り 4 日) + 期限切れ招待。
 * 検証:
 *   1. 署名前プレビュー — /portal/signin?token= で実招待元/プロジェクト名/
 *      招待先メール/実「残り 4 日」が描画される (推測なし・DB 突合)
 *   2. プレビューは read-only (use_count/同意が動かない)
 *   3. 「同意してサインイン」→ /portal 到達 + use_count=1 +
 *      legal/confidential_consented_at 永続 (DB 突合)
 *   4. 再サインインで初回同意時刻が上書きされない
 *   5. 期限切れトークンは誠実表示 (エラーバナー + プレビューカード非描画)
 * 終了時にシード削除 (再実行可能)。
 */
import { createHash } from 'node:crypto';
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

// ---- シード (前回残留掃除つき) --------------------------------------------
sql("delete from client_invitations where email like 'gap028-%@ext.example'");

const row = one(
  "select u.id || '|' || coalesce(u.display_name,'') || '|' || w.name || '|' || p.id || '|' || p.name from users u join workspaces w on w.owner_user_id=u.id join projects p on p.workspace_id=w.id and p.deleted_at is null where u.email='design-audit@example.com' order by p.created_at limit 1",
);
const [, inviterName, wsName, pid, projectName] = row.split('|');
const invitedEmail = `gap028-${mark}@ext.example`;
const rawToken = `gap028-preview-token-${mark}-0123456789`;
const tokenHash = createHash('sha256').update(rawToken).digest('hex');
const rawExpired = `gap028-expired-token-${mark}-0123456789`;
const expiredHash = createHash('sha256').update(rawExpired).digest('hex');

const invId = one(
  `insert into client_invitations (project_id, email, token_hash, scopes, expires_at) values ('${pid}','${invitedEmail}','${tokenHash}', jsonb_build_array('view','comment'), now() + interval '4 days') returning id`,
);
sql(
  `insert into client_invitations (project_id, email, token_hash, scopes, created_at, expires_at) values ('${pid}','gap028-exp-${mark}@ext.example','${expiredHash}', jsonb_build_array('view'), now() - interval '10 days', now() - interval '1 day')`,
);
check(!!invId, `シード完了 (invitation ${invId.slice(0, 8)} / project ${projectName})`);

const expectedInviterLine = `${inviterName || wsName} さんから以下のプロジェクトへ招待されました。`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// ---- 1. 署名前プレビュー実描画 --------------------------------------------
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`http://localhost:3100/portal/signin?token=${rawToken}`, { waitUntil: 'networkidle' });
await page.getByText(expectedInviterLine).waitFor({ state: 'visible', timeout: 20000 });
check(true, `署名前プレビュー: 招待元行 実描画 (${expectedInviterLine})`);
check((await page.getByText(projectName, { exact: true }).count()) > 0, `プロジェクト名 実描画 (${projectName})`);
check((await page.getByText('残り 4 日').count()) > 0, '有効期限バー: 実「残り 4 日」');
const emailInput = page.locator(`input[value="${invitedEmail}"]`);
check((await emailInput.count()) === 1 && (await emailInput.isDisabled()), `招待先メール disabled 表示 (${invitedEmail})`);
await page.screenshot({ path: `${SP}/l02-preview-${mark}-card.png`, fullPage: true });

// ---- 2. プレビューは read-only -------------------------------------------
check(
  one(`select use_count || '|' || (used_at is null) || '|' || (legal_consented_at is null) from client_invitations where id='${invId}'`) === '0|true|true',
  'DB: プレビューは read-only (use_count=0 / used_at・同意 null のまま)',
);

// ---- 3. 同意してサインイン → 同意永続 -------------------------------------
for (const cb of await page.locator('input[type="checkbox"]').all()) await cb.check();
await page.getByRole('button', { name: '同意してサインイン' }).click();
await page.waitForURL((u) => u.pathname.startsWith('/portal') && !u.pathname.includes('signin'), { timeout: 20000 });
check(true, 'サインイン成功 → /portal 到達');
const afterFirst = one(
  `select use_count || '|' || (legal_consented_at is not null) || '|' || (confidential_consented_at is not null) from client_invitations where id='${invId}'`,
);
check(afterFirst === '1|true|true', `DB: use_count=1 + 同意 2 種の初回時刻を永続 (${afterFirst})`);
const firstTs = one(`select legal_consented_at || '|' || confidential_consented_at from client_invitations where id='${invId}'`);
await page.screenshot({ path: `${SP}/l02-preview-${mark}.png` });

// ---- 4. 再サインインで初回同意時刻は不変 ----------------------------------
const page2 = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page2.goto(`http://localhost:3100/portal/signin?token=${rawToken}`, { waitUntil: 'networkidle' });
await page2.getByText(expectedInviterLine).waitFor({ state: 'visible', timeout: 20000 });
for (const cb of await page2.locator('input[type="checkbox"]').all()) await cb.check();
await page2.getByRole('button', { name: '同意してサインイン' }).click();
await page2.waitForURL((u) => u.pathname.startsWith('/portal') && !u.pathname.includes('signin'), { timeout: 20000 });
const secondTs = one(`select legal_consented_at || '|' || confidential_consented_at from client_invitations where id='${invId}'`);
check(
  one(`select use_count from client_invitations where id='${invId}'`) === '2' && secondTs === firstTs,
  'DB: 再サインインは use_count=2 だが初回同意時刻は不変 (法務証跡)',
);

// ---- 5. 期限切れトークンの誠実表示 ----------------------------------------
const page3 = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page3.goto(`http://localhost:3100/portal/signin?token=${rawExpired}`, { waitUntil: 'networkidle' });
await page3.getByRole('alert').first().waitFor({ state: 'visible', timeout: 20000 });
check(
  (await page3.getByText('招待の有効期限が切れています。再発行を依頼してください。').count()) > 0,
  '期限切れ: 誠実なエラーバナー実描画',
);
check(
  (await page3.getByText(/さんから以下のプロジェクトへ招待されました/).count()) === 0,
  '期限切れ: プレビューカードは描画しない (偽メタを出さない)',
);

await browser.close();
sql(`delete from client_invitations where email like 'gap028-%@ext.example'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/l02-preview-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
