/**
 * S-L03 クライアントプロジェクトビュー — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-l03.mjs
 *
 * 招待→署名 (API) で client JWT を取得し、ポータル表示・R-T08 越境 403・
 * 無トークン誘導・不正トークン 401・サインアウト (cookie 破棄→遷移) を実証。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const staffToken = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const api = async (method, path, body, bearer = staffToken) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);
const vis = (loc, t = 10000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
const mark = Math.random().toString(36).slice(2, 7);
const email = `audit-l03-${mark}@example.com`;

// ── 招待 → API 署名で client JWT 取得 ──
const inv = await api('POST', '/client-invitations', {
  project_id: PID, email, scopes: ['view', 'comment'], ttl_days: 7,
  client_display_name: `小松様 ${mark}`,
});
const rawToken = inv.json?.data?.token;
const signin = await api('POST', '/client/auth/signin', { invitation_token: rawToken, display_name: `小松様 ${mark}` }, null);
const clientJwt = signin.json?.data?.client_access_token;
ok('TC1 招待→署名で client JWT 取得', signin.status === 200 && !!clientJwt);

// R-T08 越境: 別プロジェクトを client JWT で読むと 403
const otherPid = sql(`select id from projects where id != '${PID}' and deleted_at is null limit 1`);
if (otherPid) {
  const cross = await api('GET', `/client/projects/${otherPid}`, undefined, clientJwt);
  ok('TC2 R-T08 越境 403 (別プロジェクト)', cross.status === 403, `status=${cross.status}`);
} else {
  ok('TC2 R-T08 越境 403 (別プロジェクト)', false, '他プロジェクト無し');
}
// staff API は client JWT で 401 (JWT 系統分離)
const staffApi = await api('GET', '/me', undefined, clientJwt);
ok('TC3 staff API は client JWT を拒否 (401)', staffApi.status === 401, `status=${staffApi.status}`);

// ── UI: モック基準ショット ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/client/S-L03-project.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-L03-${tag}.png`, fullPage: true });
  await c.close();
}

// ── ポータル表示 (client cookie のみ) ──
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'atelier_client_access', value: clientJwt, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/portal?project=${PID}`, { waitUntil: 'networkidle' });
ok('TC4 ヘッダ: 表示名 + 権限ラベル', await vis(page.getByText(`小松様 ${mark}`)) && await vis(page.getByText('閲覧 + コメント 可')));
ok('TC5 限定アクセスバナー', await vis(page.getByText('限定アクセスモード：')));
ok('TC6 プロジェクトカードが実データ', await vis(page.getByRole('heading', { name: 'ECサイトリニューアル' })));
ok('TC7 アクセス範囲 (scopes 実データ)', await vis(page.getByText('各成果物にコメントを残せます')));
await page.screenshot({ path: `${SCRATCH}/shots/S-L03-desktop-1440.png`, fullPage: true });

// R-T08 越境 UI: 別プロジェクト → 403 文言
if (otherPid) {
  await page.goto(`http://localhost:3100/portal?project=${otherPid}`, { waitUntil: 'networkidle' });
  ok('TC8 UI 越境 403 文言', await vis(page.getByText('このプロジェクトを参照する権限がありません。')));
}

// サインアウト → cookie 破棄 + /portal/signin へ
await page.goto(`http://localhost:3100/portal?project=${PID}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'サインアウト' }).click();
await page.waitForURL((u) => u.pathname === '/portal/signin', { timeout: 15000 });
const cookiesAfter = await ctx.cookies('http://localhost:3100');
ok('TC9 サインアウトで cookie 破棄 + signin へ遷移', !cookiesAfter.some((c) => c.name === 'atelier_client_access' && c.value));
await ctx.close();

// 無 cookie → middleware が /portal/signin へリダイレクト (redirect パラメータ付き)
const nCtx = await browser.newContext({ viewport: { width: 1440, height: 800 } });
const nPage = await nCtx.newPage();
await nPage.goto(`http://localhost:3100/portal?project=${PID}`, { waitUntil: 'networkidle' });
ok('TC10 無 cookie は /portal/signin へリダイレクト', new URL(nPage.url()).pathname === '/portal/signin');
// 署名改ざん (exp は有効) → middleware は通過し、API 401 でページ内文言
const tampered = clientJwt.slice(0, -4) + 'AAAA';
await nCtx.addCookies([{ name: 'atelier_client_access', value: tampered, domain: 'localhost', path: '/' }]);
await nPage.goto(`http://localhost:3100/portal?project=${PID}`, { waitUntil: 'networkidle' });
ok('TC11 署名不正トークンは 401 文言 (ページ内)', await vis(nPage.getByText('セッションの有効期限が切れました。再度サインインしてください。')));
await nCtx.close();

// ── 390px ──
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
await m.addCookies([{ name: 'atelier_client_access', value: clientJwt, domain: 'localhost', path: '/' }]);
const p3 = await m.newPage();
await p3.goto(`http://localhost:3100/portal?project=${PID}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(1500);
const hasHScroll = await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('TC12 390px 横スクロールなし', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-L03-mobile-390.png`, fullPage: true });
await m.close();
await browser.close();

// ── 後片付け ──
sql(`delete from client_invitations where email='${email}'`);
ok('TC13 自作データ削除', sql(`select count(*) from client_invitations where email='${email}'`) === '0');

let fail = 0;
for (const [s, n, e] of R) { if (fail += s === 'FAIL' ? 1 : 0, true) console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
