import { test, expect } from '@playwright/test';

test('S-F01 工程ワークフロー: フェーズ表示', async ({ page }) => {
  await page.goto('/workflow/s_f01');
  await expect(page.getByRole('heading', { name: '工程ワークフロー' })).toBeVisible();
});
