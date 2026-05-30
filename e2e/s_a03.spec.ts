import { test, expect } from '@playwright/test';

/**
 * S-A03 ワークスペース設定 E2E — T-UC-02
 */

test.describe('S-A03 ワークスペース設定', () => {
  test('設定フォームが表示される', async ({ page }) => {
    await page.goto('/auth/s_a03');
    await expect(page.getByRole('heading', { name: 'ワークスペース設定' })).toBeVisible();
  });
});
