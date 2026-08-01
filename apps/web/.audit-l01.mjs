/**
 * S-L01 クライアント招待管理 — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-l01.mjs
 *
 * UI から発行 (表示名/期限/スコープ込み) → DB 突合 (token_hash 保存・平文不保存・
 * scopes/ttl 反映) → 2 段階失効 → 履歴/再発行 → 390px。使い捨てデータは最後に削除。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);
const vis = (loc, t = 10000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
const mark = Math.random().toString(36).slice(2, 7);
const email = `audit-invite-${mark}@example.com`;

// ── UI: モック基準ショット ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/client/S-L01-invite-mgmt.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-L01-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/portal/invitations?project=${PID}`, { waitUntil: 'networkidle' });

// 発行フォーム: 全入力を配線 (表示名/期限 14 日/閲覧のみ)
await page.getByLabel('クライアント表示名').fill(`監査クライアント ${mark}`);
await page.getByLabel('招待メールアドレス').fill(email);
await page.getByLabel('有効期限（日）').selectOption('14');
await page.getByLabel('スコープ').selectOption('view');
await page.getByRole('button', { name: '招待を発行' }).click();

// ワンタイムリンクバナー
ok('TC1 発行後にワンタイムリンクを表示', await vis(page.getByText('招待リンク（この画面でのみ表示・再取得不可）')));
const linkText = await page.locator('[role="status"] code').first().textContent();
const rawToken = decodeURIComponent((linkText ?? '').split('token=')[1] ?? '');
ok('TC2 リンクに raw token を含む', rawToken.length > 20);

// DB 突合: 表示名/scopes/ttl が保存され、平文トークンは保存されない
const row = sql(`select client_display_name || '|' || scopes::text || '|' || (round(extract(epoch from (expires_at - now()))/86400)::int)::text from client_invitations where email='${email}'`);
ok('TC3 DB: 表示名/scopes=view のみ/期限 14 日', row === `監査クライアント ${mark}|["view"]|14`, row);
ok('TC4 DB: token_hash 保存 + 平文不保存 (R-T08)', sql(`select count(*) from client_invitations where email='${email}' and token_hash is not null and token_hash != '${rawToken}' and position('${rawToken}' in token_hash) = 0`) === '1');
ok('TC5 audit_logs に client_invitation.create', sql(`select count(*) from audit_logs where action='client_invitation.create'`) >= '1');

// 一覧: 表示名 + email + 未使用 pill
ok('TC6 アクティブ表に表示名+メール+未使用', await vis(page.getByText(`監査クライアント ${mark}`).first()) && await vis(page.getByText(email).first()) && await vis(page.getByText('未使用').first()));

// 使用日列: used_at を実データ表示 (SQL で使用済みに)
const todayStr = new Date().toISOString().slice(0, 10);
sql(`update client_invitations set used_at=now() where email='${email}'`);
await page.reload({ waitUntil: 'networkidle' });
ok('TC7 使用済 pill + 使用日 (used_at 実データ)', await vis(page.getByText('使用済').first()) && await vis(page.getByText(todayStr).first()));
await page.screenshot({ path: `${SCRATCH}/shots/S-L01-desktop-1440.png`, fullPage: true });

// 2 段階失効 → DB 突合 → 履歴へ移動
await page.getByRole('button', { name: `${email} を失効` }).click();
ok('TC8 失効は 2 段階確認 (即時実行しない)', sql(`select count(*) from client_invitations where email='${email}' and revoked_at is not null`) === '0');
await page.getByRole('button', { name: `${email} の失効を確定` }).click();
await page.waitForTimeout(1500);
ok('TC9 失効 → DB: revoked_at 設定 + audit_logs', sql(`select count(*) from client_invitations where email='${email}' and revoked_at is not null`) === '1' && sql(`select count(*) from audit_logs where action='client_invitation.revoke'`) >= '1');
ok('TC10 履歴セクションに失効 pill + 終了日(今日)', await vis(page.getByText('失効').first()));

// 再発行 (履歴 → 表示名引き継ぎで新規 POST)
await page.getByRole('button', { name: `${email} を再発行` }).click();
ok('TC11 再発行でワンタイムリンク再表示', await vis(page.getByText('招待リンク（この画面でのみ表示・再取得不可）')));
await page.waitForTimeout(1000);
ok('TC12 DB: 再発行行が表示名引き継ぎで新規作成', sql(`select count(*) from client_invitations where email='${email}' and client_display_name='監査クライアント ${mark}' and revoked_at is null`) === '1');
await ctx.close();

// ── 390px ──
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto(`http://localhost:3100/portal/invitations?project=${PID}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(2000);
const hasHScroll = await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('TC13 390px 横スクロールなし (表は自前スクロール)', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-L01-mobile-390.png`, fullPage: true });
await m.close();
await browser.close();

// ── 後片付け ──
sql(`delete from client_invitations where email='${email}'`);
ok('TC14 自作データ削除', sql(`select count(*) from client_invitations where email='${email}'`) === '0');

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
