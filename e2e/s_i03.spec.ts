import { test, expect } from '@playwright/test';

test('S-I03 実行モニター: ログ表示', async ({ page }) => {
  await page.goto('/tasks/s_i03');
  await expect(page.getByRole('log')).toBeVisible();
});
