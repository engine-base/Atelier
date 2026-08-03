/**
 * GAP-003 ピン留め実操作監査 (S-E01 右ペイン 主力決定カード)
 *
 * 実 UI で: 確定事項をシード → チャット右ペインの主力決定カードで
 * 「ピン留め」クリック → PATCH /decisions/{id} {pinned:true} → DB 突合
 * → 表示が「ピン留め済み」(aria-pressed=true) → 解除で false へ戻る往復。
 * 再実行可能 (毎回新規 decision、終了時に論理削除)。
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();

const mark = Math.random().toString(36).slice(2, 7);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

const pid = sql(
  "select p.id from projects p join workspaces w on w.id=p.workspace_id join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' and p.deleted_at is null order by p.created_at limit 1",
);
const body = `ピン監査-${mark}: 配色は secondary を正とする`;
const decId = sql(
  `insert into decisions (project_id, status, body) values (cast('${pid}' as uuid),'decided','${body}') returning id`,
).split('\n')[0].trim();
check(!!decId, `decision シード (${decId.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
// 右ペイン (ContextPane) はスレッド選択時のみ描画 — 既存スレッドへ直行
const tid = sql(
  `select id from chat_threads where project_id='${pid}' and deleted_at is null order by created_at desc limit 1`,
);
check(!!tid, `既存スレッドへ直行 (${tid.slice(0, 8)})`);
await page.goto(`http://localhost:3100/chat?thread=${tid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

// 主力決定カードにシードした決定が出る
const pinBtn = page.getByRole('button', { name: `${body} をピン留め` });
await pinBtn.waitFor({ state: 'visible', timeout: 15000 });
check(true, '主力決定カードに新規決定 + ピン留めボタン描画');

// ピン留め → PATCH → DB 突合 + 済表示
await pinBtn.click();
const pinnedBtn = page.getByRole('button', { name: `${body} のピン留めを外す` });
await pinnedBtn.waitFor({ state: 'visible', timeout: 10000 });
check((await pinnedBtn.getAttribute('aria-pressed')) === 'true', 'ピン留め済み表示 (aria-pressed=true)');
check(sql(`select pinned from decisions where id='${decId}'`) === 't', 'DB: pinned=true');

// 一覧先頭に来る (サーバー order by pinned desc) — 再取得後の先頭カードを実検証
await page.waitForTimeout(800);
const firstBody = await page
  .locator('div.text-\\[12\\.5px\\].font-semibold')
  .first()
  .innerText()
  .catch(() => '');
check(firstBody.includes(`ピン監査-${mark}`), `ピン留めが一覧先頭 (先頭カード: ${firstBody.slice(0, 24)}…)`);

// 解除 → false へ戻る
await pinnedBtn.click();
await page.getByRole('button', { name: `${body} をピン留め` }).waitFor({ state: 'visible', timeout: 10000 });
check(sql(`select pinned from decisions where id='${decId}'`) === 'f', 'DB: 解除で pinned=false');

await page.screenshot({ path: `${SP}/e01-pin-${mark}.png` });
await browser.close();
sql(`update decisions set deleted_at=now() where id='${decId}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/e01-pin-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
