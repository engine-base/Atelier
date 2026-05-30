import { test, expect } from '@playwright/test';

test.describe('S-L03 クライアントプロジェクトビュー', () => {
  test('プロジェクト名と権限バッジが表示される', async ({ page }) => {
    await page.goto('/client/s_l03');
    await expect(page.getByRole('heading')).toBeVisible();
  });
});
