/**
 * S-A03 ワークスペース設定 — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-a03.mjs
 * 注意: 検証用 WS を新規作成しその中で改名/メンバー/トークン/削除まで実施
 *       (監査 WS 本体は touch しない)。使い捨てユーザーを 1 名サインアップする。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const api = async (method, path, body, tok = token) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// モック基準 (3 幅)
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1200 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/workspace/S-A03-settings.html', {
    waitUntil: 'networkidle',
  });
  await p.screenshot({ path: `${SCRATCH}/shots/S-A03-${tag}.png`, fullPage: true });
  await c.close();
}

// 検証用 WS を API で作成 (監査 WS を汚さない)
const wsRes = await api('POST', '/workspaces', { name: '監査検証WS' });
const wsId = wsRes.json?.data?.id;
if (!wsId) { console.error('WS 作成失敗', wsRes.status); process.exit(1); }

// 招待用の使い捨てユーザー
const invEmail = `a03-member-${Math.random().toString(36).slice(2, 8)}@example.com`;
await api('POST', '/auth/signup', {
  email: invEmail, password: 'Passw0rd!123', display_name: 'A03 Member',
  consents: [
    { type: 'terms_of_service', version: '1.0', accepted: true },
    { type: 'privacy_policy', version: '1.0', accepted: true },
  ],
});

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/workspace-settings?workspace=${wsId}`, {
  waitUntil: 'networkidle',
});
await page.locator('h1:has-text("ワークスペース設定")').waitFor({ timeout: 30000 });

// TC1: タブが実リンク (死にタブ是正) — 招待管理/退会は実ページ href
const inviteHref = await page.getByRole('link', { name: '招待管理' }).getAttribute('href');
const taikaiHref = await page.getByRole('link', { name: '退会' }).getAttribute('href');
ok('TC1 タブ実リンク化 (招待管理/退会)', inviteHref === '/portal/invitations' && taikaiHref === '/data-deletion', `invite=${inviteHref} taikai=${taikaiHref}`);
ok('TC2 「プラン」死にタブ撤去 / アイコン死にボタン撤去',
  (await page.getByRole('link', { name: 'プラン' }).count()) === 0 &&
  (await page.getByRole('button', { name: '変更' }).count()) === 0);

// TC3: 名称変更 → PATCH → DB 突合
await page.getByLabel(/名前/).fill('監査検証WS 改名');
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1500);
const dbName = sql(`select name from workspaces where id='${wsId}'`);
ok('TC3 名称変更 → DB 反映', dbName === '監査検証WS 改名', `db=${dbName}`);
await page.screenshot({ path: `${SCRATCH}/shots/S-A03-desktop.png`, fullPage: true });

// TC4: メンバー招待 (実 POST) → 一覧反映 + DB
await page.getByRole('button', { name: /メンバー招待|招待/ }).first().click();
await page.getByLabel(/メール/).last().fill(invEmail);
await page.getByRole('button', { name: /追加|招待する|送信/ }).last().click();
await page.waitForTimeout(1800);
const memDb = sql(`select count(*) from workspace_memberships m join users u on u.id=m.user_id where m.workspace_id='${wsId}' and u.email='${invEmail}'`);
ok('TC4 メンバー招待 → DB 反映', memDb === '1', `db=${memDb}`);
ok('TC5 メンバー一覧に反映', await page.locator(`text=${invEmail}`).first().isVisible({ timeout: 8000 }).catch(() => false));

// TC6: MCP トークン発行 → plaintext 1 度だけ表示 → DB → 失効
await page.getByRole('button', { name: '発行' }).first().click();
const tokenNameInput = page.getByLabel(/名前|トークン名/).last();
if (await tokenNameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
  await tokenNameInput.fill('監査トークン');
  await page.getByRole('button', { name: /発行|作成/ }).last().click();
}
await page.waitForTimeout(1800);
const patShown = await page.locator('text=再表示できません').first().isVisible({ timeout: 8000 }).catch(() => false);
const tokDb = sql(`select count(*) from mcp_tokens where workspace_id='${wsId}' and revoked_at is null`);
ok('TC6 MCP トークン発行 → plaintext 提示 + DB', patShown && tokDb === '1', `shown=${patShown} db=${tokDb}`);

// TC7: AI 学習トグル ON 保存 → users.ai_learning_opt_out=false → リロードで ON 復元 (実値初期化)
await page.getByLabel(/AI 学習への利用を許可する/).check();
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1500);
const meOpt = sql(`select ai_learning_opt_out from users where email='design-audit@example.com'`);
ok('TC7 AI 学習 ON 保存 → DB opt_out=false', meOpt === 'f', `db=${meOpt}`);
await page.reload({ waitUntil: 'networkidle' });
await page.locator('h1:has-text("ワークスペース設定")').waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);
ok('TC8 リロード後トグル ON 復元 (旧実装は常に OFF 表示)', await page.getByLabel(/AI 学習への利用を許可する/).isChecked());
// 後始末: OFF へ戻す
await page.getByLabel(/AI 学習への利用を許可する/).uncheck();
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(1200);

// TC9: WS 削除 (2 段階) → DB 論理削除 → /projects へ (v2 で UI 断線解消)
await page.getByRole('button', { name: 'ワークスペースを削除' }).click();
ok('TC9 削除 1 クリック目は確認のみ', await page.locator('text=本当に削除しますか？').isVisible());
await page.getByRole('button', { name: '削除を確定' }).click();
await page.waitForURL((u) => u.pathname === '/projects', { timeout: 20000 });
const wsDeleted = sql(`select deleted_at is not null from workspaces where id='${wsId}'`);
ok('TC10 削除確定 → DB 論理削除 + /projects 遷移', wsDeleted === 't', `deleted=${wsDeleted}`);
await ctx.close();

// 390px
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto('http://localhost:3100/workspace-settings', { waitUntil: 'networkidle' });
await p3.locator('h1:has-text("ワークスペース設定")').waitFor({ timeout: 30000 });
await p3.waitForTimeout(800);
const hasHScroll = await p3.evaluate(
  () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
);
ok('TC11 390px 横スクロールなし (WS フォールバックで表示)', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-A03-mobile-390.png`, fullPage: true });
await m.close();
await browser.close();

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
