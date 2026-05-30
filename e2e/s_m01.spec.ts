import { test, expect } from '@playwright/test';

test('S-M01 議事録アップロード', async ({ page }) => {
  await page.goto('/upload/s_m01');
  await expect(page.getByRole('heading', { name: '議事録アップロード' })).toBeVisible();
});
