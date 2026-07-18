import { chromium } from '@playwright/test';
import fs from 'fs';
const SCRATCH = '/tmp/claude-0/-home-user-Atelier/bc7559f9-cc1e-5410-be06-ff8dd9ba00be/scratchpad';
const token = fs.readFileSync(`${SCRATCH}/token.txt`, 'utf8').trim();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addCookies([{ name: 'atelier_access', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
const R = [];
const ok = (name, cond, extra = '') => { R.push([cond ? 'PASS' : 'FAIL', name, extra]); };

await page.goto('http://localhost:3100/approvals', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// TC1: KPI 実算出
const urgentKpi = await page.locator('section[aria-label="承認 KPI"] >> text=緊急（仕様変更）').isVisible();
ok('TC1 KPI 4連が描画される', urgentKpi);

// TC2: チップ絞り込み → タスク承認のみに
await page.getByRole('button', { name: /^タスク承認/ }).click();
await page.waitForTimeout(400);
const taskOnly = await page.locator('article').count();
const noScope = await page.locator('text=越境同意 UI の仕様が更新されました').count();
ok('TC2 チップ「タスク承認」で 3 件に絞られ scope_change が消える', taskOnly === 3 && noScope === 0, `articles=${taskOnly}`);
await page.getByRole('button', { name: /^すべて/ }).click();
await page.waitForTimeout(400);

// TC3: 行選択 → 詳細ペイン (影響範囲 + 工程チップ)
await page.getByRole('button', { name: '越境同意 UI の仕様が更新されました を判断する' }).click();
await page.waitForTimeout(400);
const detailTitle = await page.locator('aside[aria-label="承認詳細"] h2').textContent();
const impactVisible = await page.locator('aside >> text=影響を受ける機能').isVisible();
const stagesVisible = await page.locator('aside >> text=再実行する工程を選んでください').isVisible();
ok('TC3 「判断する」→ 詳細ペインに影響範囲/工程チップ', (detailTitle||'').includes('越境同意') && impactVisible && stagesVisible);

// TC4: 工程チップの実チェック操作
const designChip = page.locator('aside label', { hasText: 'デザイン（同意画面のみ）' });
await designChip.click();
const checked = await designChip.locator('input').isChecked();
const archDisabled = await page.locator('aside label', { hasText: 'アーキ設計' }).locator('input').isDisabled();
ok('TC4 工程チェックのトグル可 / 影響なし工程は disabled', checked && archDisabled);

// TC5: あとで判断する → 選択解除
await page.getByRole('button', { name: 'あとで判断する' }).click();
await page.waitForTimeout(300);
const emptyDetail = await page.locator('text=リストから案件を選ぶと').isVisible();
ok('TC5 あとで判断する → 詳細ペインが空に戻る', emptyDetail);

// TC6: 通常案件をメモ付きで承認 → 楽観除外 + DB 突合は shell 側で
await page.getByRole('button', { name: 'T-027 逐次配信（リアルタイム応答）の検証が完了', exact: false }).first().click();
await page.waitForTimeout(400);
await page.locator('aside textarea').fill('監査ラウンドで確認済み。例外なし。');
await page.getByRole('button', { name: '承認する' }).click();
await page.waitForTimeout(1200);
const gone = await page.locator('text=T-027 逐次配信').count();
ok('TC6 メモ付き承認 → リストから即時除外', gone === 0);

// TC7: クイックアクションで却下 (行内ボタン)
await page.getByRole('button', { name: 'T-028 スレッド一覧の権限制御が検証完了 を却下' }).click();
await page.waitForTimeout(1200);
const gone2 = await page.locator('text=T-028 スレッド一覧').count();
ok('TC7 行内クイック却下 → リストから即時除外', gone2 === 0);

// TC8: KPI 未処理が 7→5 に減っている (再取得後)
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const pendingVal = await page.locator('section[aria-label="承認 KPI"] div', { hasText: /^未処理$/ }).locator('..').locator('.tabular-nums').first().textContent().catch(() => '');
ok('TC8 リロード後 未処理 KPI が 5', (pendingVal||'').trim() === '5', `val=${pendingVal}`);

// TC9: プロジェクト絞り込み select が実項目を持つ
const opts = await page.locator('select option').allTextContents();
ok('TC9 プロジェクト select に実プロジェクト名', opts.some(o => o.includes('ECサイトリニューアル')), JSON.stringify(opts));

for (const [s, n, e] of R) console.log(s, '|', n, e ? `| ${e}` : '');
const fails = R.filter(r => r[0] === 'FAIL').length;
console.log(`RESULT: ${R.length - fails}/${R.length} PASS`);
await browser.close();
process.exit(fails ? 1 : 0);
