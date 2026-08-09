/**
 * GAP-031④⑦ 実操作監査 (S-T02 ローカル一括再取込 + S-T06 SKILL.md 取込)
 *
 * S-T02: 監査用スキルディレクトリ (ATELIER_SKILLS_DIR — API 起動時に指定) に
 * SKILL.md ×2 をシード → UI から 2 段階確認で再取込 → バナー「追加 2 件」→
 * DB 突合 → 再実行で「変更なし 2 件」(dedupe) → SKILL.md を書換えて再実行 →
 * 「更新 1 件」+ DB content 反映 + is_active 等は保持。
 * S-T06: SKILL.md ファイルを file input へ実セット → frontmatter 解析で
 * ダイアログにプレフィル → 追加する → DB (platform knowledge) 突合。
 * 終了時にシード削除 (再実行可能)。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { chromium } from '@playwright/test';

const SP = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const SKILLS_DIR = `${SP}/audit-skills`;
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

// ── シード: 監査用スキルディレクトリ (前回残留も掃除) ─────────────────
fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
fs.mkdirSync(`${SKILLS_DIR}/reimport-a-${mark}`, { recursive: true });
fs.mkdirSync(`${SKILLS_DIR}/reimport-b-${mark}`, { recursive: true });
fs.writeFileSync(
  `${SKILLS_DIR}/reimport-a-${mark}/SKILL.md`,
  `---\nname: reimport-a-${mark}\ndescription: 監査用スキル A\n---\n# A body v1\n`,
);
fs.writeFileSync(
  `${SKILLS_DIR}/reimport-b-${mark}/SKILL.md`,
  `# B body (frontmatter 無し)\n`,
);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto('http://localhost:3100/signin', { waitUntil: 'networkidle' });
await page.getByLabel(/メール/).fill('design-audit@example.com');
await page.locator('input[type="password"]').first().fill('Passw0rd!123');
await page.getByRole('button', { name: 'サインイン' }).click();
await page.waitForURL((u) => u.pathname !== '/signin', { timeout: 25000 });

// ── S-T02: 一括再取込 ────────────────────────────────────────────────
await page.goto('http://localhost:3100/admin/skills', { waitUntil: 'networkidle' });
const reimportBtn = page.getByRole('button', { name: '~/.claude/skills/ から再取込' });
await reimportBtn.waitFor({ state: 'visible', timeout: 15000 });
await reimportBtn.click();
check(
  await page.getByText('サーバーの ~/.claude/skills/ を走査して一括反映しますか？').isVisible(),
  '2 段階確認 (一括 write)',
);
await page.getByRole('button', { name: '実行する' }).click();
await page.getByRole('status').waitFor({ state: 'visible', timeout: 15000 });
let banner = await page.getByRole('status').innerText();
check(banner.includes('追加 2 件') && banner.includes('変更なし 0 件'), `1 回目: 追加 2 件 (${banner.slice(0, 60)}…)`);
check(
  one(`select count(*) from skills where name in ('reimport-a-${mark}','reimport-b-${mark}')`) === '2',
  'DB: skills 2 行 upsert (frontmatter 名 + ディレクトリ名フォールバック)',
);
check(
  one(`select description from skills where name='reimport-a-${mark}'`) === '監査用スキル A',
  'DB: frontmatter description 反映',
);

// 2 回目: 変更なし (dedupe)
await page.getByRole('button', { name: '閉じる' }).click();
await reimportBtn.click();
await page.getByRole('button', { name: '実行する' }).click();
await page.getByRole('status').waitFor({ state: 'visible', timeout: 15000 });
banner = await page.getByRole('status').innerText();
check(banner.includes('追加 0 件') && banner.includes('変更なし 2 件'), `2 回目: 変更なし 2 件 (dedupe)`);

// 3 回目: 内容書換え + 画面で無効化した is_active が保持されるか
sql(`update skills set is_active=false where name='reimport-a-${mark}'`);
fs.writeFileSync(
  `${SKILLS_DIR}/reimport-a-${mark}/SKILL.md`,
  `---\nname: reimport-a-${mark}\ndescription: 監査用スキル A\n---\n# A body v2\n`,
);
await page.getByRole('button', { name: '閉じる' }).click();
await reimportBtn.click();
await page.getByRole('button', { name: '実行する' }).click();
await page.getByRole('status').waitFor({ state: 'visible', timeout: 15000 });
banner = await page.getByRole('status').innerText();
check(banner.includes('更新 1 件') && banner.includes('変更なし 1 件'), `3 回目: 更新 1 件`);
check(
  one(`select (content_md like '%A body v2%')::text || '|' || is_active::text from skills where name='reimport-a-${mark}'`) === 'true|false',
  'DB: 内容は反映・is_active (運用設定) は保持',
);
await page.screenshot({ path: `${SP}/t02-reimport-${mark}.png` });

// ── S-T06: SKILL.md 取込 ─────────────────────────────────────────────
const importFile = `${SP}/skillmd-import-${mark}.md`;
fs.writeFileSync(
  importFile,
  `---\nname: 取込監査-${mark}\ndescription: SKILL.md 取込の監査\n---\n# 取込本文\nknowledge-${mark}\n`,
);
await page.goto('http://localhost:3100/admin/platform-knowledge', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'SKILL.md 取込' }).waitFor({ state: 'visible', timeout: 15000 });
await page.getByLabel('SKILL.md ファイルを選択').setInputFiles(importFile);
await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 10000 });
check(
  (await page.getByRole('dialog').innerText()).includes(`SKILL.md「取込監査-${mark}」を解析しました`),
  '解析ノート表示 (frontmatter name/description)',
);
check(
  (await page.getByRole('dialog').locator('input').first().inputValue()) === `取込監査-${mark}`,
  'タイトルに frontmatter name をプレフィル',
);
await page.getByRole('button', { name: '追加する' }).click();
await page.waitForTimeout(1800);
const kRow = one(
  `select account_type || '|' || (content_md like '%knowledge-${mark}%')::text from knowledge_nodes where title='取込監査-${mark}'`,
);
check(kRow === 'platform|true', `DB: platform ナレッジとして登録 (${kRow})`);
check(
  (await page.getByRole('cell', { name: `取込監査-${mark}` }).count()) > 0,
  '一覧に実描画',
);
await page.screenshot({ path: `${SP}/t06-import-${mark}.png` });

await browser.close();
sql(`delete from skills where name in ('reimport-a-${mark}','reimport-b-${mark}')`);
sql(`delete from knowledge_nodes where title='取込監査-${mark}'`);
fs.rmSync(SKILLS_DIR, { recursive: true, force: true });
fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.rmSync(importFile, { force: true });
console.log(`---\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (shots: ${SP}/t02-reimport-${mark}.png, ${SP}/t06-import-${mark}.png)`);
process.exit(failures === 0 ? 0 : 1);
