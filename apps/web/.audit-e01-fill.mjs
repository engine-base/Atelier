// SE01-004 / SE01-019 の未実施 2 行を実機で決着させる (planned=0 化)
import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const WS = '9498aa8b-08cb-4cb0-9656-f31961db8496';
const PID = '0a651a74-5dd8-4850-8c65-f1d92381d14e';
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

// --- SE01-004: スレッド 0 件の空状態 ---
const proj = await api('POST', '/projects', { workspace_id: WS, name: '空スレッド検証', type: 'personal' });
const p2 = proj.json.data.id;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await c.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await c.newPage();
await page.goto(`http://localhost:3100/chat?project=${p2}`, { waitUntil: 'networkidle' });
const empty = await page
  .locator('text=スレッドがありません。「新規スレッド」で AI 社員との会話を始めましょう。')
  .isVisible({ timeout: 20000 })
  .catch(() => false);
ok('SE01-004 スレッド0件の空状態 (500にならない)', empty);
await page.screenshot({ path: `${SCRATCH}/shots/SE01-004-empty.png` });

// --- SE01-019: 他 WS ユーザーから見えない (RLS) ---
const email = `rls-check-${Math.random().toString(36).slice(2, 8)}@example.com`;
const su = await api('POST', '/auth/signup', {
  email, password: 'Passw0rd!123', display_name: 'RLS Checker',
  consents: [
    { type: 'terms_of_service', version: '1.0', accepted: true },
    { type: 'privacy_policy', version: '1.0', accepted: true },
  ],
}, '');
if (su.status !== 201) { console.error('signup failed', su.status, JSON.stringify(su.json).slice(0,300)); process.exit(1); }
const si = await api('POST', '/auth/signin', { email, password: 'Passw0rd!123' }, '');
const tokB = si.json?.data?.access_token;
if (!tokB) { console.error('signin failed', si.status); process.exit(1); }
// 監査 WS のスレッド ID を 1 つ取得 (user A)
const th = await api('GET', `/chat/threads?project_id=${PID}`);
const threadId = th.json?.data?.[0]?.id;
// user B: 一覧に出ない + 直接 ID アクセス 404
const listB = await api('GET', `/chat/threads?project_id=${PID}`, null, tokB);
const listInvisible = listB.status === 403 || listB.status === 404 || (Array.isArray(listB.json?.data) && listB.json.data.length === 0);
const getB = threadId ? await api('GET', `/chat/threads/${threadId}`, null, tokB) : { status: 0 };
ok('SE01-019 他WSユーザー: 一覧に出ない', listInvisible, `list=${listB.status} n=${listB.json?.data?.length}`);
ok('SE01-019 他WSユーザー: 直接 ID 404', getB.status === 404, `get=${getB.status} thread=${threadId}`);
// UI でも確認: user B で /chat を開くと監査 WS のスレッドが 1 件も見えない
const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await c2.addCookies([{ name: 'atelier_access', value: tokB, domain: 'localhost', path: '/' }]);
const pB = await c2.newPage();
await pB.goto(`http://localhost:3100/chat?project=${PID}`, { waitUntil: 'networkidle' });
await pB.waitForTimeout(2500);
const leak = await pB.locator('text=キックオフ').count().catch(() => 0);
ok('SE01-019 UI: 他WSスレッド名が描画されない', leak === 0, `leak=${leak}`);
await pB.screenshot({ path: `${SCRATCH}/shots/SE01-019-rls.png` });
await browser.close();

// 後片付け: 検証用 project 削除
await api('DELETE', `/projects/${p2}`);

let fail = 0;
for (const [s, n, e] of R) { if (s === 'FAIL') fail++; console.log(`${s}  ${n}${e ? `  [${e}]` : ''}`); }
console.log(`---\n${R.length - fail}/${R.length} PASS`);
process.exit(fail ? 1 : 0);
