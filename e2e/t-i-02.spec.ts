/**
 * T-I-02 E2E: プロジェクト一覧 → タスクボード → 再生 → 承認
 *
 * - S-B01 プロジェクト一覧から特定 project を選ぶ
 * - S-I01 タスクボードに移動、blocked タスクの再生 button を確認
 * - S-J01 承認待ちでアクションを試行
 */

import { test, expect } from '@playwright/test';

test.describe('T-I-02: プロジェクト → タスク再生 → 承認', () => {
  test('プロジェクト一覧 → タスクボード → 承認待ち の導線', async ({ page }) => {
    // 1. プロジェクト一覧
    await page.goto('/projects/s_b01');
    await expect(page.getByRole('heading', { name: 'プロジェクト一覧' })).toBeVisible();
    await expect(page.getByText('Sample Project')).toBeVisible();

    // 2. タスクボード
    await page.goto('/tasks/s_i01');
    await expect(page.getByRole('group', { name: 'タスクボード' })).toBeVisible();
    // ready or blocked の再生ボタンが少なくとも 1 つ
    const playButtons = page.getByRole('button', { name: /を実行$/ });
    await expect(playButtons.first()).toBeVisible();
    await playButtons.first().click();

    // 3. 承認待ち
    await page.goto('/approvals/s_j01');
    await expect(page.getByRole('heading', { name: '承認待ち' })).toBeVisible();
    const approveButtons = page.getByRole('button', { name: /を承認$/ });
    await expect(approveButtons.first()).toBeVisible();
  });
});
