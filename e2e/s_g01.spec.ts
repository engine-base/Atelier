import { test, expect } from '@playwright/test';

test('S-G01 成果物ビューア', async ({ page }) => {
  await page.goto('/outputs/s_g01');
  await expect(page.getByRole('heading', { name: 'サンプル成果物' })).toBeVisible();
});
