import { test, expect } from '@playwright/test';

test('S-T01 運営ダッシュボード', async ({ page }) => {
  await page.goto('/admin/s_t01');
  await expect(page.getByRole('heading', { name: '運営ダッシュボード' })).toBeVisible();
});
