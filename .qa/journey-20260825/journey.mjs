/**
 * 通し (ドッグフーディング) — 2026-08-25
 *
 * 実ブラウザ (Chromium) で、本番ビルドの Next.js + 実 API + 実 Postgres に対し
 * **新規登録から順に、人がやる操作をそのまま**やる。
 *
 * 最後の通しは 2026-08-17 で、それ以降 GAP-201〜209 の 9 件が通しで確認されて
 * いなかった。ここで一周させる。
 *
 * **できないこと (正直に)**: この環境には Bridge も Claude 契約も無いので、
 * AI が実際に考える工程 (チャット応答・成果物生成) は動かせない。
 * 「AI を呼ぶ手前まで」と「AI 抜きで完結する操作」を対象にする。
 */
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/`);
const { chromium } = require('@playwright/test');

const WEB = process.env.WEB ?? 'http://127.0.0.1:3100';
const OUT = process.env.OUT ?? '.';
const STAMP = process.env.STAMP ?? 'x';
const EMAIL = `journey-${STAMP}@example.com`;
const PASSWORD = 'journey-strong-password-2026';

let ng = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => { console.log(`  NG   ${m}`); ng += 1; };
const check = (c, m) => (c ? ok(m) : bad(m));
const shot = (pg, n) => pg.screenshot({ path: `${OUT}/shots/${n}.png` });
const vis = (loc, t = 15000) => loc.waitFor({ state: 'visible', timeout: t }).then(() => true).catch(() => false);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP' });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 120)));

console.log(`使う人: ${EMAIL}`);
console.log('');

// ------------------------------------------------------------------ //
console.log('[1] 新規登録 — 何も持っていない人が入り口に立つ');
// ------------------------------------------------------------------ //
await page.goto(`${WEB}/signin`, { waitUntil: 'domcontentloaded' });
check(await vis(page.getByRole('tab', { name: '新規登録' })), 'サインイン画面に「新規登録」がある');
await page.getByRole('tab', { name: '新規登録' }).click();
await page.waitForTimeout(800);
await page.locator('input[name="email"]').fill(EMAIL);
await page.locator('input[name="password"]').fill(PASSWORD);
await page.locator('input[name="confirm"]').fill(PASSWORD);
// 同意チェックは **必須** (サーバーも 422 で弾く)。人がやるのと同じく実際に押す。
await page.locator('input[name="consent"]').check();
await shot(page, '01-signup-filled');
const submit = page.getByRole('button', { name: '新規登録', exact: true }).first();
check(await vis(submit), '登録ボタンがある');
await submit.click();

const left = await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 40000 })
  .then(() => true).catch(() => false);
const alerts1 = await page.getByRole('alert').allInnerTexts().catch(() => []);
console.log(`     登録後の URL: ${page.url()}`);
if (alerts1.filter(Boolean).length) console.log(`     alert: ${JSON.stringify(alerts1.filter(Boolean).slice(0, 2))}`);
check(left, '登録が通ってサインイン画面から抜ける');
await shot(page, '02-after-signup');

// ------------------------------------------------------------------ //
console.log('');
console.log('[2] まだワークスペースが無い状態 — 死んだ入り口を出していないか (GAP-207)');
// ------------------------------------------------------------------ //
{
  const navCount = await page.getByRole('navigation', { name: 'ホーム' }).count();
  check(navCount === 0, 'ワークスペースが無いうちはサイドバーを出していない');
  await shot(page, '03-onboarding');
}

// ------------------------------------------------------------------ //
console.log('');
console.log('[3] ワークスペースを作る');
// ------------------------------------------------------------------ //
{
  const nameBox = page.getByLabel(/ワークスペース名|名前/).first();
  if (await vis(nameBox, 8000)) {
    await nameBox.fill('通し検証WS');
    const create = page.getByRole('button', { name: /作成|作る|次へ|保存/ }).first();
    await create.click();
    await page.waitForTimeout(4000);
  } else {
    console.log('     (作成フォームが自動で出なかったので /workspace-settings を直接開く)');
    await page.goto(`${WEB}/workspace-settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const nb = page.getByLabel(/ワークスペース名|名前/).first();
    if (await vis(nb, 8000)) {
      await nb.fill('通し検証WS');
      await page.getByRole('button', { name: /作成|作る|保存/ }).first().click();
      await page.waitForTimeout(4000);
    }
  }
  console.log(`     URL: ${page.url()}`);
  // GAP-207: 作った瞬間に、再読み込みせずシェルが出ること
  check(await vis(page.getByRole('navigation', { name: 'ホーム' }), 20000),
        '**再読み込みせずに**サイドバーが出る (GAP-207 で直した所)');
  check(await vis(page.getByRole('button', { name: /^アカウント: / }), 10000),
        'アカウントメニューが出る (GAP-209)');
  await shot(page, '04-workspace-created');
}

// ------------------------------------------------------------------ //
console.log('');
console.log('[4] プロジェクトを作る');
// ------------------------------------------------------------------ //
await page.goto(`${WEB}/projects`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
{
  const newBtn = page.getByRole('button', { name: /新規|作成|追加|プロジェクトを/ }).first();
  check(await vis(newBtn, 15000), 'プロジェクト一覧に作成の導線がある');
  await newBtn.click();
  await page.waitForTimeout(1500);
  const pn = page.getByLabel(/プロジェクト名|名前/).first();
  if (await vis(pn, 8000)) {
    await pn.fill('通しテスト案件');
    await page.getByRole('button', { name: /作成|保存|追加/ }).last().click();
    await page.waitForTimeout(4000);
  }
  await shot(page, '05-project-created');
  const listed = await page.getByText('通しテスト案件').first().isVisible().catch(() => false);
  check(listed, '作ったプロジェクトが一覧に出る');
}

// ------------------------------------------------------------------ //
console.log('');
console.log('[5] 工程 — プロジェクトを作ると 9 工程が自動で用意されるか');
// ------------------------------------------------------------------ //
{
  const link = page.getByText('通しテスト案件').first();
  if (await link.isVisible().catch(() => false)) { await link.click(); await page.waitForTimeout(3000); }
  console.log(`     URL: ${page.url()}`);
  await page.goto(`${WEB}/workflow`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const body = await page.locator('main').first().innerText().catch(() => '');
  console.log(`     工程画面: ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
  check(body.replace(/\s+/g, '').length > 40, '工程画面が何かを表示している (空白のままにしない)');
  await shot(page, '06-workflow');
}

// ------------------------------------------------------------------ //
console.log('');
console.log('[6] 主要画面を順に開いて、壊れていないか');
// ------------------------------------------------------------------ //
for (const [label, path] of [['タスク', '/tasks'], ['ナレッジ', '/knowledge'],
                             ['テンプレート', '/templates'], ['承認待ち', '/approvals'],
                             ['AI社員', '/employees']]) {
  await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  const t = (await page.locator('main').first().innerText().catch(() => '')).replace(/\s+/g, '');
  const nav = await page.getByRole('navigation', { name: 'ホーム' }).count();
  check(t.length > 20 && nav === 1, `${label} (${path}) が中身つきで開き、ナビもある`);
}
await shot(page, '07-screens');

// ------------------------------------------------------------------ //
console.log('');
console.log('[7] 出る — サインアウト (GAP-209)');
// ------------------------------------------------------------------ //
{
  await page.getByRole('button', { name: /^アカウント: / }).first().click();
  await page.waitForTimeout(600);
  const so = page.getByRole('menuitem', { name: 'サインアウト' });
  check(await vis(so, 10000), 'メニューにサインアウトがある');
  await shot(page, '08-menu');
  await so.click();
  const landed = await page.waitForURL(/\/signin/, { timeout: 30000 }).then(() => true).catch(() => false);
  check(landed, '押すとサインイン画面に着地する');
  const c = (await ctx.cookies()).find((x) => x.name === 'atelier_access');
  check(!c || !c.value, 'cookie が消えている');
  await shot(page, '09-signed-out');
}

// ------------------------------------------------------------------ //
console.log('');
console.log('[8] 戻る — 同じ人でサインインし直すと、作ったものが残っている');
// ------------------------------------------------------------------ //
{
  await page.goto(`${WEB}/signin`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: 'サインイン', exact: true }).click();
  const back = await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 40000 })
    .then(() => true).catch(() => false);
  check(back, '同じ email + password でサインインできる');
  await page.goto(`${WEB}/projects`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  check(await vis(page.getByText('通しテスト案件').first(), 15000),
        '**作ったプロジェクトが残っている**');
  await shot(page, '10-back-in');
}

console.log('');
console.log(`JS エラー: ${pageErrors.length} 件 ${pageErrors.length ? JSON.stringify(pageErrors.slice(0, 3)) : ''}`);
check(pageErrors.length === 0, '通しのあいだ JS エラーが出ない');

await browser.close();
console.log('');
console.log(`使った email: ${EMAIL}`);
if (ng > 0) { console.log(`FAIL: ${ng} 件`); process.exit(1); }
console.log('PASS: 新規登録から作成・閲覧・サインアウト・復帰まで一周した');
