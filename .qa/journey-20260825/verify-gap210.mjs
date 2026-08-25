/**
 * GAP-210 の実ブラウザ検証 — 本当に直ったかを画面で見る。
 *
 *   ① 新規登録した人の同意記録が **表示している文書の版** になる
 *      → その結果、登録直後に再同意の帯が **出ない**
 *   ② 同意文に社内の課題番号が出ない
 *   ③ 入力エラーが日本語で出る
 */
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/`);
const { chromium } = require('@playwright/test');

const WEB = process.env.WEB ?? 'http://127.0.0.1:3100';
const OUT = process.env.OUT ?? '.';
const EMAIL = `gap210-${process.env.STAMP}@example.com`;
const PW = 'gap210-strong-password-2026';

let ng = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => { console.log(`  NG   ${m}`); ng += 1; };
const check = (c, m) => (c ? ok(m) : bad(m));

const br = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await br.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ja-JP' });
const pg = await ctx.newPage();

console.log(`使う人: ${EMAIL}`);
console.log('');
console.log('[②] 同意文に社内の課題番号が出ていないか');
await pg.goto(`${WEB}/signin`, { waitUntil: 'domcontentloaded' });
await pg.getByRole('tab', { name: '新規登録' }).click();
await pg.waitForTimeout(1200);
const label = await pg.locator('input[name="consent"]').evaluate(
  (el) => el.closest('label')?.innerText.replace(/\s+/g, ' ').trim() ?? '',
);
console.log(`     同意文: ${label.slice(0, 110)}…`);
check(!/GAP-\d+/.test(label), '同意文に GAP-xxx が出ていない');
check(label.includes('越境同意') && label.includes('外部送信されません'),
      '越境同意の説明そのものは残っている (番号だけ消した)');

console.log('');
console.log('[③] 入力エラーが日本語で出るか');
await pg.locator('input[name="email"]').fill(EMAIL);
await pg.locator('input[name="password"]').fill(PW);
await pg.getByRole('button', { name: '新規登録' }).click();
await pg.waitForTimeout(1500);
const msgs = (await pg.getByRole('alert').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
console.log(`     出た文言: ${JSON.stringify(msgs)}`);
check(!msgs.some((m) => /String must contain/.test(m)), '英語の zod 既定メッセージが出ない');
check(msgs.some((m) => m.includes('パスワード確認')), '日本語で「パスワード確認」を促している');
await pg.screenshot({ path: `${OUT}/shots/12-gap210-validation.png` });

console.log('');
console.log('[①] 登録して、直後に再同意の帯が出ないか');
await pg.locator('input[name="confirm"]').fill(PW);
await pg.locator('input[name="consent"]').check();
await pg.getByRole('button', { name: '新規登録' }).click();
const inside = await pg.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 40000 })
  .then(() => true).catch(() => false);
check(inside, '登録できる');
await pg.waitForTimeout(3500);
const body = (await pg.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
console.log(`     着地: ${pg.url()}`);
check(!body.includes('更新しました'),
      '**登録した直後の人に「規約を更新しました」の帯を出さない** (GAP-210 の本題)');
check(!body.includes('同意をお願いします'),
      'いま同意したばかりなのに、もう一度同意を求めない');
await pg.screenshot({ path: `${OUT}/shots/13-gap210-after-signup.png` });

await br.close();
console.log('');
console.log(`使った email: ${EMAIL}`);
if (ng > 0) { console.log(`FAIL: ${ng} 件`); process.exit(1); }
console.log('PASS: 同意記録が版に紐づき、登録直後の誤った再同意が消えた');
