/**
 * S-PUB01〜04 公開系 — design-audit 実操作検証 (再実行可能)
 *
 * 前提: postgres/API(:8000)/web(:3100) 稼働。
 * 実行: node .audit-pub.mjs
 * 注意: PUB04 の実申請は使い捨てサインアップユーザーで行う (audit_logs に記録のみ)。
 */
import { chromium } from '@playwright/test';
import { execSync } from 'child_process';

const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`sudo -u postgres psql atelier_dev -tA -c "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const api = async (method, path, body, tok) => {
  const r = await fetch(`http://localhost:8000${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const R = [];
const ok = (n, c, e = '') => R.push([c ? 'PASS' : 'FAIL', n, e]);

/** body_md から描画確認に使える素のテキスト行を 1 つ選ぶ。 */
function plainLine(md) {
  for (const line of md.split('\n')) {
    let t = line.trim();
    if (/^[#>|]/.test(t) || t.includes('|')) continue;
    // リスト項目は "- **項目**: 値" の値部分を使う
    t = t.replace(/^[-*\d.]+\s*/, '').replace(/\*\*/g, '');
    const idx = t.indexOf(': ');
    if (idx >= 0) t = t.slice(idx + 2);
    if (t.length > 14) return t.slice(0, 18);
  }
  return null;
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

// モック基準 (1440)
for (const [file, tag] of [
  ['S-PUB01-terms', 'PUB01'],
  ['S-PUB02-privacy', 'PUB02'],
  ['S-PUB03-tokushoho', 'PUB03'],
  ['S-PUB04-data-deletion', 'PUB04'],
]) {
  const c = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const p = await c.newPage();
  await p.goto(`file:///home/user/Atelier/06_mockups/public/${file}.html`, {
    waitUntil: 'networkidle',
  });
  await p.screenshot({ path: `${SCRATCH}/shots/S-${tag}-mock-1440.png`, fullPage: true });
  await c.close();
}

// ---- PUB01〜03: 未認証で正本 (API/DB) の内容が描画される ----
const DOCS = [
  ['terms_of_service', '/terms', 'PUB01'],
  ['privacy_policy', '/privacy', 'PUB02'],
  ['tokushoho', '/tokushoho', 'PUB03'],
];
const anon = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await anon.newPage();
for (const [docType, path, tag] of DOCS) {
  const apiDoc = (await api('GET', `/public/legal-documents/${docType}`)).json?.data;
  await page.goto(`http://localhost:3100${path}`, { waitUntil: 'networkidle' });
  await page.locator(`h1:has-text("${apiDoc.title}")`).waitFor({ timeout: 20000 });
  const phrase = plainLine(apiDoc.body_md);
  const bodyShown = phrase ? await page.locator(`text=${phrase}`).first().isVisible() : false;
  const verShown = await page.locator(`text=バージョン ${apiDoc.version}`).isVisible();
  const h1Count = await page.locator(`h1:has-text("${apiDoc.title}"), h2:has-text("${apiDoc.title}")`).count();
  ok(`${tag} 正本 (API/DB) の本文・版数を描画 (見出し重複なし)`, bodyShown && verShown && h1Count === 1, `phrase="${phrase}" ver=${apiDoc.version} headings=${h1Count}`);
  await page.screenshot({ path: `${SCRATCH}/shots/S-${tag}-desktop.png`, fullPage: true });
}

// ナビ相互リンク: /terms → プライバシーポリシー → 特商法表記
await page.goto('http://localhost:3100/terms', { waitUntil: 'networkidle' });
await page.getByRole('link', { name: 'プライバシーポリシー' }).click();
await page.waitForURL('**/privacy', { timeout: 15000 });
await page.getByRole('link', { name: '特商法表記' }).click();
await page.waitForURL('**/tokushoho', { timeout: 15000 });
ok('PUB 共通ヘッダーのナビが相互遷移する', true, page.url());

// ---- PUB04: 未認証 → サインイン誘導 ----
await page.goto('http://localhost:3100/data-deletion', { waitUntil: 'networkidle' });
const signinLink = page.getByRole('link', { name: 'サインインして続ける' });
await signinLink.waitFor({ timeout: 20000 });
ok('PUB04 未認証はサインイン誘導 (redirect 付き)', (await signinLink.getAttribute('href')) === '/signin?redirect=/data-deletion');
await page.screenshot({ path: `${SCRATCH}/shots/S-PUB04-anon.png`, fullPage: true });
await anon.close();

// ---- PUB04: 使い捨てユーザーで実申請 ----
const email = `del-req-${Math.random().toString(36).slice(2, 8)}@example.com`;
await api('POST', '/auth/signup', {
  email, password: 'Passw0rd!123', display_name: 'Deletion Probe',
  consents: [
    { type: 'terms_of_service', version: '1.0', accepted: true },
    { type: 'privacy_policy', version: '1.0', accepted: true },
  ],
});
const si = await api('POST', '/auth/signin', { email, password: 'Passw0rd!123' });
const tokB = si.json?.data?.access_token;
const uidB = (await api('GET', '/me', null, tokB)).json?.data?.id;

const authed = await browser.newContext({ viewport: { width: 1440, height: 1400 } });
await authed.addCookies([{ name: 'atelier_access', value: tokB, domain: 'localhost', path: '/' }]);
const p2 = await authed.newPage();
await p2.goto('http://localhost:3100/data-deletion', { waitUntil: 'networkidle' });
await p2.locator('text=削除要求フォーム').waitFor({ timeout: 20000 });
const emailField = p2.getByLabel('メールアドレス（ログイン中のアカウント）');
ok('PUB04 ログイン中メールが表示専用で出る', (await emailField.inputValue()) === email && (await emailField.isDisabled()));
ok('PUB04 削除内容チェックリスト描画 (モック準拠)', await p2.locator('text=BYOK API キー').isVisible());
await p2.screenshot({ path: `${SCRATCH}/shots/S-PUB04-desktop.png`, fullPage: true });

// 確認テキスト無しでは申請不可
await p2.getByRole('button', { name: '削除を申請する' }).click();
await p2.waitForTimeout(600);
const before = Number(sql(`select count(*) from audit_logs where action='data_deletion.request'`));
ok('PUB04 確認テキスト未入力では送信されない', await p2.getByRole('alert').filter({ hasText: '「削除する」と入力' }).first().isVisible());

// 正しく入力して実申請 → 受付番号 + audit_logs 突合
await p2.getByLabel(/削除を希望する理由/).fill('デザイン監査の実操作検証');
await p2.getByLabel(/確認のため/).fill('削除する');
await p2.getByRole('checkbox').check();
await p2.getByRole('button', { name: '削除を申請する' }).click();
await p2.locator('text=削除申請を受け付けました').waitFor({ timeout: 20000 });
ok('PUB04 実申請 → 受付番号表示', await p2.locator('text=受付番号').isVisible());
const after = Number(sql(`select count(*) from audit_logs where action='data_deletion.request' and actor_id='${uidB}'`));
ok('PUB04 申請が audit_logs に記録される (DB 突合)', after >= 1 && Number(sql(`select count(*) from audit_logs where action='data_deletion.request'`)) === before + 1, `actor_rows=${after}`);
await p2.screenshot({ path: `${SCRATCH}/shots/S-PUB04-receipt.png` });
await authed.close();

// ---- レスポンシブ 390: 4 ページとも横スクロール無し ----
const m = await browser.newContext({ viewport: { width: 390, height: 844 } });
const p3 = await m.newPage();
for (const [path, tag] of [
  ['/terms', 'PUB01'],
  ['/privacy', 'PUB02'],
  ['/tokushoho', 'PUB03'],
  ['/data-deletion', 'PUB04'],
]) {
  await p3.goto(`http://localhost:3100${path}`, { waitUntil: 'networkidle' });
  await p3.waitForTimeout(700);
  const hasHScroll = await p3.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
  );
  ok(`${tag} 390px 横スクロールなし`, !hasHScroll);
  await p3.screenshot({ path: `${SCRATCH}/shots/S-${tag}-mobile-390.png`, fullPage: true });
}
await m.close();
await browser.close();

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
