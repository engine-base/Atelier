/**
 * T-I-10 a11y axe-core 検査 (主要 screen WCAG 2.2 AA)。
 *
 * @axe-core/playwright で violation 数を 0 にする。33 画面全 vs sample 主要画面で
 * トレードオフ; CI 時間を抑えるため代表 8 画面に絞り、残りは将来 nightly job で。
 *
 * 違反 0 件を必達 (W3 T-US-13 + Bundle B/C/D で a11y 配線済)。
 */

import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

const TARGETS: ReadonlyArray<{ name: string; path: string }> = [
  { name: 'S-A01 サインイン/サインアップ', path: '/auth/s_a01' },
  { name: 'S-B01 プロジェクト一覧', path: '/projects/s_b01' },
  { name: 'S-B02 ダッシュボード', path: '/projects/s_b02' },
  { name: 'S-I01 タスクボード', path: '/tasks/s_i01' },
  { name: 'S-I02 タスク詳細', path: '/tasks/s_i02' },
  { name: 'S-J01 承認待ち', path: '/approvals/s_j01' },
  { name: 'S-K01 ナレッジエクスプローラ', path: '/knowledge/s_k01' },
  { name: 'S-PUB01 利用規約', path: '/public/s_pub01' },
];

for (const t of TARGETS) {
  test(`T-I-10 a11y: ${t.name} は WCAG 2.2 AA 違反 0 件`, async ({ page }) => {
    await page.goto(t.path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
