/**
 * 認証を入れても落ちる spec について、**実際にその画面を開いて何が出ているか**を見る。
 *
 * 目的は「仕様(spec)が古いのか / 画面が壊れているのか」を分けること。
 *   - 画面が描かれていて見出しだけ違う  -> spec が古い (製品は無事)
 *   - 画面が空 / エラー                -> 製品の問題
 */
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/`);
const { chromium } = require('@playwright/test');

const WEB = process.env.WEB ?? 'http://127.0.0.1:3100';
const SECRET = process.env.ATELIER_AUTH_JWT_SECRET ?? 'local-human-qa-secret-at-least-32-characters-long';
const USER = 'a818edcd-8e05-4bd9-a0d1-aaf80c777adf';
const WS = '2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69';
const OUT = process.env.OUT ?? '.';

const b64 = (s) => Buffer.from(s).toString('base64url');
const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const p = b64(JSON.stringify({ sub: USER, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }));
const jwt = `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;

const CASES = [
  ['s_a01', '/auth/s_a01', 'サインイン'],
  ['s_b01', '/projects/s_b01', 'プロジェクト一覧'],
  ['s_b02', '/projects/s_b02', 'KPI 一覧'],
  ['s_b03', '/projects/s_b03', 'プロジェクト設定'],
  ['s_c02', '/employees/s_c02', 'AI 社員詳細・編集'],
  ['s_e01', '/chat/s_e01', 'チャット'],
  ['s_g01', '/outputs/s_g01', 'サンプル成果物'],
  ['s_h01', '/mocks/s_h01', 'ビューポート切替'],
  ['s_i01', '/tasks/s_i01', 'タスクボード'],
  ['s_i02', '/tasks/s_i02', 'タスク詳細タブ'],
  ['s_i03', '/tasks/s_i03', '(ログ表示)'],
  ['s_j01', '/approvals/s_j01', '承認待ち'],
  ['s_l01', '/client/s_l01', 'クライアント招待管理'],
  ['s_l02', '/client/s_l02', 'クライアントサインイン'],
  ['s_l03', '/client/s_l03', '(権限バッジ)'],
  ['s_m01', '/upload/s_m01', '議事録アップロード'],
  ['s_n01', '/sales/s_n01', '商談ドラフト'],
  ['s_pub04', '/public/s_pub04', 'データ削除請求'],
  ['s_t01', '/admin/s_t01', '運営ダッシュボード'],
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ja-JP' });
await ctx.addCookies([{ name: 'atelier_access', value: jwt, domain: '127.0.0.1', path: '/' }]);
await ctx.addInitScript((ws) => {
  try { window.localStorage.setItem('atelier_current_workspace', ws); } catch { /* noop */ }
}, WS);

const rows = [];
for (const [id, path, expected] of CASES) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 90)));
  let final = '', h1 = '', bodyLen = 0, alerts = [];
  try {
    await page.goto(`${WEB}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    final = new URL(page.url()).pathname;
    h1 = (await page.locator('h1').allInnerTexts().catch(() => [])).join(' / ').replace(/\s+/g, ' ').slice(0, 60);
    const body = await page.locator('main, body').first().innerText().catch(() => '');
    bodyLen = body.replace(/\s+/g, '').length;
    alerts = (await page.getByRole('alert').allInnerTexts().catch(() => []))
      .map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 2);
    await page.screenshot({ path: `${OUT}/shots/${id}.png` });
  } catch (e) {
    errors.push(`goto失敗: ${String(e).slice(0, 80)}`);
  }
  // 判定: 本文が十分あり JS エラーが無ければ「画面は描かれている」
  const rendered = bodyLen > 120 && errors.length === 0;
  rows.push({ id, path, final, expected, h1, bodyLen, alerts, errors, rendered });
  await page.close();
}
await browser.close();

console.log('id       spec の URL              着地した URL             期待した見出し        実際の h1                         本文字数 判定');
console.log('-'.repeat(150));
for (const r of rows) {
  console.log(
    `${r.id.padEnd(8)} ${r.path.padEnd(24)} ${(r.final || '-').padEnd(24)} ${r.expected.padEnd(20)} ${(r.h1 || '(h1 無し)').padEnd(33)} ${String(r.bodyLen).padStart(6)}  ${r.rendered ? '画面は出ている' : '★要調査'}`,
  );
  if (r.alerts.length) console.log(`         alert: ${JSON.stringify(r.alerts)}`);
  if (r.errors.length) console.log(`         err  : ${JSON.stringify(r.errors)}`);
}
const bad = rows.filter((r) => !r.rendered);
console.log('');
console.log(`画面は出ている: ${rows.length - bad.length} / ${rows.length}   要調査: ${bad.length}`);
