import { test, expect } from '@playwright/test';

test('S-F02 フェーズ管理: 一覧表示', async ({ page }) => {
  await page.goto('/workflow/s_f02');
  await expect(page.getByRole('heading', { name: 'フェーズ管理' })).toBeVisible();
});
