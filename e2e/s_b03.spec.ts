import { test, expect } from '@playwright/test';

test.describe('S-B03 プロジェクト設定', () => {
  test('設定フォームが表示される', async ({ page }) => {
    await page.goto('/projects/s_b03');
    await expect(page.getByRole('heading', { name: 'プロジェクト設定' })).toBeVisible();
  });
});
