/**
 * S-A01 サインイン/サインアップ — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働。
 * 実行: node .audit-a01.mjs
 * 注意: 使い捨てユーザーを実サインアップする (DB に users/consents 行が残る)。
 */
import { chromium } from '@playwright/test';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// モック基準 (3 幅)
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/auth/S-A01-signin.html', {
    waitUntil: 'networkidle',
  });
  await p.screenshot({ path: `${SCRATCH}/shots/S-A01-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.locator('h1:has-text("Atelier へようこそ")').waitFor({ timeout: 30000 });

// TC1: 構成 (ブランド/タブ/フォーム/フッターリンク)
ok('TC1 タブが実 tab (signin selected)', (await page.getByRole('tab', { name: 'サインイン' }).getAttribute('aria-selected')) === 'true');
ok('TC2 フッター特商法リンク', (await page.getByRole('link', { name: '特商法表記' }).getAttribute('href')) === '/tokushoho');
await page.screenshot({ path: `${SCRATCH}/shots/S-A01-desktop.png`, fullPage: true });

// TC3: Magic Link — メール入力 → 送信 → 202 秘匿応答 + 監査ログ + 通知表示
const auditBefore = Number(sql("select count(*) from audit_logs where action='auth.magic_link.issued'"));
await page.getByLabel(/メールアドレス/).fill('design-audit@example.com');
await page.getByRole('button', { name: 'マジックリンクを送る' }).click();
await page.locator('text=サインイン用リンクを送信しました').waitFor({ timeout: 15000 });
const auditAfter = Number(sql("select count(*) from audit_logs where action='auth.magic_link.issued'"));
ok('TC3 マジックリンク送信 → 通知 + 監査ログ +1', auditAfter === auditBefore + 1, `before=${auditBefore} after=${auditAfter}`);

// TC4: サインアップタブ → 同意文に法令リンク → 実サインアップ → 自動サインイン → /projects
await page.getByRole('tab', { name: '新規登録' }).click();
ok('TC4 同意文に利用規約/プライバシー実リンク',
  (await page.getByRole('link', { name: '利用規約' }).getAttribute('href')) === '/terms' &&
  (await page.getByRole('link', { name: 'プライバシーポリシー' }).getAttribute('href')) === '/privacy');
const email = `a01-probe-${Math.random().toString(36).slice(2, 8)}@example.com`;
await page.getByLabel(/メールアドレス/).fill(email);
await page.getByLabel(/^パスワード\s*\*?$/).first().fill('Passw0rd!123');
await page.getByLabel(/パスワード確認/).fill('Passw0rd!123');
// 同意なしで送信 → エラー
await page.getByRole('button', { name: '新規登録' }).click();
ok('TC5 同意なしサインアップは拒否', await page.getByRole('alert').filter({ hasText: '同意が必要' }).first().isVisible({ timeout: 8000 }).catch(() => false));
await page.getByRole('checkbox').check();
await page.getByRole('button', { name: '新規登録' }).click();
await page.waitForURL('**/projects**', { timeout: 30000 });
ok('TC6 実サインアップ → 自動サインイン → /projects', true, page.url());
const consents = sql(`select count(*) from consents c join users u on u.id=c.user_id where u.email='${email}'`);
const aiOptin = sql(`select accepted from consents c join users u on u.id=c.user_id where u.email='${email}' and c.type='ai_training_optin'`);
ok('TC7 consents 3 種記録 + AI 学習は既定 OFF (絶対ルール6)', consents === '3' && aiOptin === 'f', `consents=${consents} ai_optin=${aiOptin}`);
await ctx.close();

// TC8: 誤パスワード → エラー表示 / 正しい → redirect パラメータへ
const c2 = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const p2 = await c2.newPage();
await p2.goto('http://localhost:3100/signin?redirect=/knowledge', { waitUntil: 'networkidle' });
await p2.getByLabel(/メールアドレス/).fill(email);
await p2.getByLabel(/^パスワード/).first().fill('WrongPass999!');
await p2.getByRole('button', { name: 'サインイン' }).click();
ok('TC8 誤パスワードで明示エラー', await p2.getByRole('alert').first().isVisible({ timeout: 15000 }));
await p2.getByLabel(/^パスワード/).first().fill('Passw0rd!123');
await p2.getByRole('button', { name: 'サインイン' }).click();
await p2.waitForURL((u) => u.pathname === '/knowledge', { timeout: 30000 });
ok('TC9 redirect パラメータ先へ遷移', new URL(p2.url()).pathname === '/knowledge', p2.url());
await c2.close();

// 390px
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p3 = await m.newPage();
await p3.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await p3.locator('h1:has-text("Atelier へようこそ")').waitFor({ timeout: 30000 });
const hasHScroll = await p3.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
);
ok('TC10 390px 横スクロールなし', !hasHScroll);
await p3.getByRole('tab', { name: '新規登録' }).click();
ok('TC11 390px タブ操作可能', (await p3.getByRole('tab', { name: '新規登録' }).getAttribute('aria-selected')) === 'true');
await p3.screenshot({ path: `${SCRATCH}/shots/S-A01-mobile-390.png`, fullPage: true });
await m.close();
await browser.close();

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
