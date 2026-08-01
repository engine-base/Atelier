/**
 * S-L02 クライアントサインイン — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働、scratchpad/token.txt に有効トークン。
 * 実行: node .audit-l02.mjs
 *
 * 招待発行 (API) → 無認証ブラウザで招待リンクを開く → 同意ゲート → サインイン →
 * /portal 遷移 → used_at / client cookie 分離 (R-T08) を DB/cookie 突合。
 * 401 (不正/失効) / 410 (期限切れ) の文言も実 API で検証する。
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
const api = async (method, path, body) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);
const vis = (loc, t = 10000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);
const mark = Math.random().toString(36).slice(2, 7);

const issue = async (email) => {
  const r = await api('POST', '/client-invitations', {
    project_id: PID, email, scopes: ['view', 'comment'], ttl_days: 7,
    client_display_name: `監査C ${mark}`,
  });
  return { id: r.json?.data?.id, token: r.json?.data?.token };
};

const inv1 = await issue(`audit-l02-a-${mark}@example.com`);
const inv2 = await issue(`audit-l02-b-${mark}@example.com`);
const inv3 = await issue(`audit-l02-c-${mark}@example.com`);
ok('TC1 招待 3 件発行 (raw token 取得)', [inv1, inv2, inv3].every((i) => i.token));
// DB 制約 (expiry_reasonable) は過去日付を拒むため、直近未来に縮めて経過を待つ
sql(`update client_invitations set expires_at = now() + interval '1 second' where id='${inv2.id}'`);
await new Promise((r) => setTimeout(r, 2500));
await api('POST', `/client-invitations/${inv3.id}/revoke`);

// ── UI: モック基準ショット ──
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1000 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/client/S-L02-signin.html', { waitUntil: 'networkidle' });
  await p.screenshot({ path: `${SCRATCH}/shots/S-L02-${tag}.png`, fullPage: true });
  await c.close();
}

// ── 無認証コンテキストで招待リンクを開く (スタッフ cookie なし) ──
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/portal/signin?token=${encodeURIComponent(inv1.token)}`, { waitUntil: 'networkidle' });

ok('TC2 グリーティング + サインインカード表示', await vis(page.getByRole('heading', { name: 'ご招待ありがとうございます' })) && await vis(page.getByRole('heading', { name: 'クライアントポータルへサインイン' })));
ok('TC3 招待トークンが URL から自動展開', (await page.getByLabel(/招待トークン/).inputValue()).length > 20);
ok('TC4 法務リンクが実ルート (/terms /privacy)', (await page.locator('a[href="/terms"]').count()) === 1 && (await page.locator('a[href="/privacy"]').count()) === 1);

// 同意ゲート: 未チェックでは送信されない
await page.getByRole('button', { name: '同意してサインイン' }).click();
ok('TC5 同意なしでは送信ブロック + エラー表示', await vis(page.getByText('利用規約・プライバシーポリシー・越境同意への同意が必要です')) && sql(`select count(*) from client_invitations where id='${inv1.id}' and used_at is not null`) === '0');

// 同意して送信 → /portal へ
for (const cb of await page.getByRole('checkbox').all()) await cb.check();
await page.screenshot({ path: `${SCRATCH}/shots/S-L02-desktop-1440.png`, fullPage: true });
await page.getByRole('button', { name: '同意してサインイン' }).click();
await page.waitForURL((u) => u.pathname === '/portal' && u.searchParams.get('project') === PID, { timeout: 15000 });
ok('TC6 サインイン成功 → /portal?project= へ遷移', true);
ok('TC7 DB: used_at が設定される', sql(`select count(*) from client_invitations where id='${inv1.id}' and used_at is not null`) === '1');

// R-T08: クライアント cookie のみ・スタッフ cookie なし
const cookies = await ctx.cookies('http://localhost:3100');
ok('TC8 client_access cookie 分離 (R-T08)', cookies.some((c) => c.name === 'atelier_client_access') && !cookies.some((c) => c.name === 'atelier_access'));
await ctx.close();

// ── エラー経路: 期限切れ 410 / 失効 401 ──
const eCtx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const ePage = await eCtx.newPage();
await ePage.goto(`http://localhost:3100/portal/signin?token=${encodeURIComponent(inv2.token)}`, { waitUntil: 'networkidle' });
for (const cb of await ePage.getByRole('checkbox').all()) await cb.check();
await ePage.getByRole('button', { name: '同意してサインイン' }).click();
ok('TC9 期限切れ → 410 文言', await vis(ePage.getByText('招待の有効期限が切れています。再発行を依頼してください。')));

await ePage.goto(`http://localhost:3100/portal/signin?token=${encodeURIComponent(inv3.token)}`, { waitUntil: 'networkidle' });
for (const cb of await ePage.getByRole('checkbox').all()) await cb.check();
await ePage.getByRole('button', { name: '同意してサインイン' }).click();
ok('TC10 失効済み → 401 文言', await vis(ePage.getByText('招待トークンが無効です。リンクをご確認ください。')));
await eCtx.close();

// ── 390px ──
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p3 = await m.newPage();
await p3.goto(`http://localhost:3100/portal/signin?token=${encodeURIComponent(inv1.token)}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(1500);
const hasHScroll = await p3.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
ok('TC11 390px 横スクロールなし', !hasHScroll);
await p3.screenshot({ path: `${SCRATCH}/shots/S-L02-mobile-390.png`, fullPage: true });
await m.close();
await browser.close();

// ── 後片付け ──
sql(`delete from client_invitations where email like 'audit-l02-%-${mark}@example.com'`);
ok('TC12 自作データ削除', sql(`select count(*) from client_invitations where email like 'audit-l02-%'`) === '0');

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
