/**
 * S-B04 プロジェクト・シークレット — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000, ATELIER_VAULT_ENCRYPTION_KEY 必須)/web(:3100) 稼働、
 *       scratchpad/token.txt に有効トークン。
 * 実行: node .audit-b04.mjs
 * 注意: 監査用クレデンシャルを作成し最後に削除する (自作データのみ破壊)。
 */
import { chromium } from '@playwright/test';
import fs from 'fs';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
const NAME = '監査 Slack Bot Token';
const SECRET = 'xoxb-audit-secret-1a2b';
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

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

// モック基準 (3 幅)
for (const [w, tag] of [[1440, 'mock-1440'], [768, 'mock-768'], [390, 'mock-390']]) {
  const c = await browser.newContext({ viewport: { width: w, height: 1200 } });
  const p = await c.newPage();
  await p.goto('file:///home/user/Atelier/06_mockups/project/S-B04-vault.html', {
    waitUntil: 'networkidle',
  });
  await p.screenshot({ path: `${SCRATCH}/shots/S-B04-${tag}.png`, fullPage: true });
  await c.close();
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
await page.goto(`http://localhost:3100/projects/vault?project=${PID}`, {
  waitUntil: 'networkidle',
});
await page.waitForSelector('text=プロジェクト・シークレット', { timeout: 30000 });

// TC1: 主要領域が揃う
ok(
  'TC1 主要領域 (注意書き/新規追加/一覧) 描画',
  (await page.locator('text=平文は保存・表示しません').isVisible()) &&
    (await page.locator('text=新規追加').isVisible()) &&
    (await page.locator('text=クレデンシャル一覧').isVisible()),
);

// TC2: フォームから実作成 → 一覧反映 + DB 突合 (暗号化・平文非保存)
await page.getByLabel('名称').fill(NAME);
await page.getByLabel('種別').selectOption('token');
await page.getByLabel('値（保存後は二度と表示されません）').fill(SECRET);
await page.getByRole('button', { name: '暗号化して保存' }).click();
await page.locator(`text=${NAME}`).waitFor({ timeout: 15000 });
ok('TC2 作成 → 一覧反映', true);
const dbRow = sql(
  `select last4, encrypted_value, encrypted_value like '%${SECRET}%' from project_credentials where name='${NAME}' and deleted_at is null`,
);
const [l4, enc, hasPlain] = dbRow.split('|');
ok('TC3 DB: last4 記録 + 平文を含まず暗号化保存', l4 === '1a2b' && hasPlain === 'f', `last4=${l4} plain_in_db=${hasPlain} enc_len=${enc?.length}`);
ok('TC4 一覧はマスク表示 (••••last4)', await page.locator('text=••••••••1a2b').isVisible());
ok('TC5 作成者列に実ユーザー名', await page.locator('td', { hasText: 'Design Audit' }).first().isVisible());
const isoLeak = await page.locator('text=/T\\d{2}:\\d{2}:\\d{2}/').count();
ok('TC6 作成日が YYYY-MM-DD (生 ISO 露出なし)', isoLeak === 0, `iso_leak=${isoLeak}`);
await page.screenshot({ path: `${SCRATCH}/shots/S-B04-desktop.png`, fullPage: true });

// TC7: 表示 (reveal) → 平文表示 + 監査ログ記録 (DB 突合)
const auditBefore = Number(sql("select count(*) from audit_logs where action='credential.reveal'"));
const row = page.locator('tr', { hasText: NAME });
await row.getByRole('button', { name: /表示/ }).click();
await page.locator(`text=${SECRET}`).waitFor({ timeout: 15000 });
ok('TC7 表示 → 復号平文が見える', true);
const auditAfter = Number(sql("select count(*) from audit_logs where action='credential.reveal'"));
ok('TC8 reveal が監査ログに記録される', auditAfter === auditBefore + 1, `before=${auditBefore} after=${auditAfter}`);

// TC9: 隠す → マスクへ戻る / コピー ボタン存在
ok('TC9 コピー ボタン表示', await row.getByRole('button', { name: 'コピー' }).isVisible());
await row.getByRole('button', { name: '隠す' }).click();
ok('TC10 隠す → マスク復帰', await page.locator('text=••••••••1a2b').isVisible());

// TC11: RLS — 別ユーザーから一覧不可・reveal 404
const email = `vault-rls-${Math.random().toString(36).slice(2, 8)}@example.com`;
await api('POST', '/auth/signup', {
  email, password: 'Passw0rd!123', display_name: 'Vault RLS',
  consents: [
    { type: 'terms_of_service', version: '1.0', accepted: true },
    { type: 'privacy_policy', version: '1.0', accepted: true },
  ],
}, '');
const tokB = (await api('POST', '/auth/signin', { email, password: 'Passw0rd!123' }, '')).json?.data?.access_token;
const credId = sql(`select id from project_credentials where name='${NAME}' and deleted_at is null`);
const listB = await api('GET', `/projects/${PID}/credentials`, null, tokB);
const listBlocked = listB.status === 403 || listB.status === 404 || (Array.isArray(listB.json?.data) && listB.json.data.length === 0);
const revealB = await api('POST', `/projects/${PID}/credentials/${credId}/reveal`, null, tokB);
ok('TC11 RLS: 他ユーザーは一覧不可', listBlocked, `list=${listB.status} n=${listB.json?.data?.length}`);
ok('TC12 RLS: 他ユーザーの reveal は 404/403', revealB.status === 404 || revealB.status === 403, `reveal=${revealB.status}`);

// TC13: 削除 2 段階 → DB soft-delete
await row.getByRole('button', { name: `${NAME} を削除` }).click();
ok('TC13 削除 1 クリック目は確認表示', await row.getByRole('button', { name: '削除する' }).isVisible());
await row.getByRole('button', { name: '削除する' }).click();
await page.locator(`text=${NAME}`).waitFor({ state: 'detached', timeout: 15000 });
const delState = sql(`select deleted_at is not null from project_credentials where id='${credId}'`);
ok('TC14 削除確定 → 一覧から消え DB soft-delete', delState === 't', `deleted=${delState}`);

// レスポンシブ 768 / 390
for (const [w, tag] of [[768, 'tablet-768'], [390, 'mobile-390']]) {
  const c2 = await browser.newContext({ viewport: { width: w, height: 900 } });
  await c2.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
  const p2 = await c2.newPage();
  await p2.goto(`http://localhost:3100/projects/vault?project=${PID}`, { waitUntil: 'networkidle' });
  await p2.waitForSelector('text=クレデンシャル一覧', { timeout: 30000 });
  await p2.waitForTimeout(500);
  if (w === 390) {
    const hasHScroll = await p2.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    );
    ok('TC15 390px: body 横スクロールなし (表は自前スクロール)', !hasHScroll);
    // 390 でフォームが操作できる
    await p2.getByLabel('名称').fill('モバイル確認');
    ok('TC16 390px: フォーム入力可能', (await p2.getByLabel('名称').inputValue()) === 'モバイル確認');
  }
  await p2.screenshot({ path: `${SCRATCH}/shots/S-B04-${tag}.png`, fullPage: true });
  await c2.close();
}

await browser.close();
// 後片付け: 監査クレデンシャルの物理削除 (自作データのみ)
sql(`delete from project_credentials where name in ('${NAME}')`);

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
