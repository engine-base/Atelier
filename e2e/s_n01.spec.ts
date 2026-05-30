import { test, expect } from '@playwright/test';

test('S-N01 商談ドラフト', async ({ page }) => {
  await page.goto('/sales/s_n01');
  await expect(page.getByRole('heading', { name: '商談ドラフト' })).toBeVisible();
});
