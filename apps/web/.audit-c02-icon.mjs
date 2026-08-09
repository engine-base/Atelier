/**
 * GAP-009 実操作監査 (S-C02 アイコン画像アップロード)
 *
 * 前提: postgres / API(:8000 — ATELIER_SUPABASE_ADMIN_API_URL=http://127.0.0.1:8790
 * + SERVICE_ROLE_KEY 設定済) / web(:3100) / storage スタブ ($SP/storage-stub.mjs) 稼働。
 *
 * 検証: 実 PNG を「画像アップロード」で選択 → 署名付き URL 発行 → 実 PUT (スタブに
 * 実バイト保存) → PATCH icon=storage_path (DB 突合) → 署名付き閲覧 URL で <img>
 * 実描画 → 「頭文字に戻す」で解除。終了時に元の icon へ復元 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const sql = (q) =>
  execSync(`PGPASSWORD=devpass psql -h localhost -U atelier_dev -d atelier_dev -tAc "${q.replaceAll('"', '\\"')}"`, {
    encoding: 'utf8',
  }).trim();
const one = (q) => sql(q).split('\n')[0].trim();

const mark = Math.random().toString(36).slice(2, 7);
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures += 1;
};

// 実 PNG (1x1 赤ピクセル) を生成
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const pngPath = `${SP}/icon-${mark}.png`;
writeFileSync(pngPath, PNG_1PX);

const uid = one("select id from users where email='design-audit@example.com'");
const emp = one(
  `select e.id from ai_employees e join workspaces w on w.id=e.workspace_id where w.owner_user_id='${uid}' and e.archived=false order by e.created_at limit 1`,
);
const originalIcon = one(`select coalesce(icon,'') from ai_employees where id='${emp}'`);
check(!!emp, `対象社員 ${emp.slice(0, 8)} (元 icon: '${originalIcon}')`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/employees/detail?employee=${emp}`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: '画像アップロード' }).waitFor({ state: 'visible', timeout: 20000 });
check(true, '「画像アップロード」ボタン実描画 (モック復元)');

// 実 PNG を選択 → 署名付き URL → PUT → PATCH
await page.locator('input[aria-label="アイコン画像を選択"]').setInputFiles(pngPath);
await page.waitForTimeout(2500);
const iconAfter = one(`select icon from ai_employees where id='${emp}'`);
check(
  iconAfter.startsWith(`avatars/ai-employees/${emp}/`) && iconAfter.endsWith('.png'),
  `DB: icon = storage_path 永続 (${iconAfter})`,
);
const stored = `${SP}/storage-objects/${iconAfter}`;
check(
  existsSync(stored) && statSync(stored).size === PNG_1PX.length,
  'storage: 実バイトが PUT 保存されている (サイズ一致)',
);
// 署名付き閲覧 URL の <img> 実描画 (naturalWidth>0 = 実ロード成功)
const imgLoaded = await page
  .waitForFunction(
    () => {
      const img = [...document.querySelectorAll('img')].find((i) => i.src.includes('/object/download/avatars/'));
      return !!img && img.naturalWidth > 0;
    },
    { timeout: 15000 },
  )
  .then(() => true)
  .catch(() => false);
check(imgLoaded, '署名付き URL の <img> 実描画 (naturalWidth>0)');
await page.screenshot({ path: `${SP}/c02-icon-${mark}.png` });

// 頭文字に戻す → 保存 → icon 解除
await page.getByRole('button', { name: '頭文字に戻す' }).click();
await page.getByRole('button', { name: '保存' }).click();
await page.waitForTimeout(2000);
check(one(`select coalesce(icon,'') from ai_employees where id='${emp}'`) === '', 'DB: 「頭文字に戻す」で icon 解除');

// 誠実表示: 非画像ファイルは即時拒否 (API を呼ばずに inline error)
const txtPath = `${SP}/not-image-${mark}.txt`;
writeFileSync(txtPath, 'not an image');
await page.locator('input[aria-label="アイコン画像を選択"]').setInputFiles(txtPath);
check(
  (await page.getByText('PNG / JPEG / WebP の画像のみアップロードできます。').count()) > 0,
  '非画像は client 側で即時拒否 (誠実 inline error)',
);

await browser.close();
sql(`update ai_employees set icon = ${originalIcon ? `'${originalIcon}'` : 'null'} where id='${emp}'`);
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/c02-icon-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
