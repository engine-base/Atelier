/**
 * GAP-011 Obsidian 連携 実操作監査 (S-K01)
 *
 * シード: ユニーク本文のナレッジ 1 件 → S-K01 で選択 →
 * ① 「Obsidian で開く」リンクが obsidian://new?name=…&content=… (実 URI) →
 * ② 「Obsidian Vault に書出」実クリック → Playwright download で zip 受領 →
 *    unzip して <scope>/<category>/<title>.md の frontmatter + 本文を DB と突合。
 * 終了時にシード削除 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
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

const wsId = one(
  "select w.id from workspaces w join users u on u.id=w.owner_user_id where u.email='design-audit@example.com' order by w.created_at limit 1",
);
sql(`delete from knowledge_nodes where title like 'Vault監査-%'`); // 前回残留掃除
const kid = one(
  `insert into knowledge_nodes (account_id, account_type, scope, category, title, content_md, tags) values ('${wsId}','workspace','common','tech','Vault監査-${mark}','vault-body-${mark} 実本文','{vault}') returning id`,
);
check(!!kid, `ナレッジシード (${kid.slice(0, 8)})`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });
await page.goto(`http://localhost:3100/knowledge?workspace=${wsId}`, { waitUntil: 'networkidle' });

// ノード選択 → 「Obsidian で開く」リンク (実 obsidian:// URI)
const item = page.getByRole('treeitem', { name: `Vault監査-${mark}` });
await item.waitFor({ state: 'visible', timeout: 15000 });
await item.click();
const openLink = page.getByRole('link', { name: 'Obsidian で開く' });
await openLink.waitFor({ state: 'visible', timeout: 10000 });
const href = await openLink.getAttribute('href');
check(
  href === `obsidian://new?name=${encodeURIComponent(`Vault監査-${mark}`)}&content=${encodeURIComponent(`vault-body-${mark} 実本文`)}`,
  `「Obsidian で開く」= 実 obsidian://new URI (${(href ?? '').slice(0, 48)}…)`,
);

// 「Obsidian Vault に書出」→ 実 zip ダウンロード
const dlPromise = page.waitForEvent('download', { timeout: 20000 });
await page.getByRole('button', { name: 'Obsidian Vault に書出' }).click();
const dl = await dlPromise;
check(dl.suggestedFilename() === 'atelier-vault.zip', `zip ダウンロード (${dl.suggestedFilename()})`);
const zipPath = `${SP}/vault-${mark}.zip`;
await dl.saveAs(zipPath);

// unzip して DB 突合
const listing = execSync(`unzip -l ${zipPath}`, { encoding: 'utf8' });
check(listing.includes(`共通/tech/Vault監査-${mark}.md`), 'zip 構成: 共通/tech/<title>.md');
const extractDir = `${SP}/vault-x-${mark}`;
execSync(`mkdir -p ${extractDir} && cd ${extractDir} && unzip -o ${zipPath} > /dev/null`);
const md = fs.readFileSync(`${extractDir}/共通/tech/Vault監査-${mark}.md`, 'utf8');
check(md.startsWith('---\n') && md.includes('category: tech') && md.includes('tags: [vault]'), 'YAML frontmatter (category/tags)');
check(md.includes(`vault-body-${mark} 実本文`), 'DB content_md と本文一致');
const dbCount = Number(one(`select count(*) from knowledge_nodes where account_id='${wsId}' and deleted_at is null`));
const zipCount = Number(execSync(`unzip -l ${zipPath} | grep -c '\\.md$'`, { encoding: 'utf8' }).trim());
check(zipCount === dbCount, `zip 件数 = DB 可視ノード数 (${zipCount} = ${dbCount})`);
await page.screenshot({ path: `${SP}/k01-obsidian-${mark}.png` });

await browser.close();
sql(`delete from knowledge_nodes where id='${kid}'`);
fs.rmSync(zipPath, { force: true });
fs.rmSync(extractDir, { recursive: true, force: true });
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shot: ${SP}/k01-obsidian-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
