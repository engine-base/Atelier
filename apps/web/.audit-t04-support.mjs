/**
 * GAP-031⑥ サポート連絡 実操作監査 (S-T04)
 *
 * 実 UI で: /admin/users → 行の「サポート連絡」→ ダイアログに件名/本文 →
 * 送信する → dry-run バナー (メール未設定環境の誠実表示) → DB 突合
 * (audit support.contact + after.subject/dry_run) → 「最近のサポート対応」
 * カードに実描画 (audit 逆引き)。終了時に監査 audit 行を削除 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const one = (q) => sql(q).split('\n')[0].trim();

const mark = Math.random().toString(36).slice(2, 7);
const subject = `監査-課金確認-${mark}`;
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto('http://localhost:3100/admin/users', { waitUntil: 'networkidle' });

// 行の「サポート連絡」→ ダイアログ
// 同一ユーザーが複数 WS の行に出るため先頭行を使う
const btn = page.getByRole('button', { name: 'design-audit@example.com へサポート連絡' }).first();
await btn.waitFor({ state: 'visible', timeout: 15000 });
await btn.click();
const dialog = page.getByRole('dialog');
await dialog.waitFor({ state: 'visible', timeout: 10000 });
check((await dialog.innerText()).includes('design-audit@example.com'), 'ダイアログに宛先表示');

await dialog.getByLabel(/件名/).fill(subject);
await dialog.getByLabel(/本文/).fill(`監査本文-${mark}\n状況の確認です。`);
const before = Number(one("select count(*) from audit_logs where action='support.contact'"));
await dialog.getByRole('button', { name: '送信する' }).click();
const banner = page.getByRole('status');
await banner.waitFor({ state: 'visible', timeout: 15000 });
const bannerText = await banner.innerText();
check(bannerText.includes('ドライラン'), `dry-run を誠実表示 (${bannerText.slice(0, 48)}…)`);

// DB 突合: audit support.contact + after
const after = Number(one("select count(*) from audit_logs where action='support.contact'"));
check(after === before + 1, `audit support.contact +1 (${before}→${after})`);
const row = one(
  `select (after->>'subject') || '|' || (after->>'dry_run') || '|' || (after->>'to_email') from audit_logs where action='support.contact' and after->>'subject'='${subject}'`,
);
check(row === `${subject}|true|design-audit@example.com`, `DB: after (subject/dry_run/to_email) 突合`);

// 最近のサポート対応カードに実描画 (audit 逆引き — invalidate 済み)
const section = page.getByRole('region', { name: '最近のサポート対応' });
await section.waitFor({ state: 'visible', timeout: 10000 });
await page.waitForTimeout(800);
check((await section.innerText()).includes(subject), '「最近のサポート対応」に実描画');
await page.screenshot({ path: `${SP}/t04-support-${mark}.png`, fullPage: true });

await browser.close();
sql(`delete from audit_logs where action='support.contact' and after->>'subject'='${subject}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/t04-support-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
