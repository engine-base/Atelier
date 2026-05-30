import { test, expect } from '@playwright/test';

test('S-PUB04 データ削除請求', async ({ page }) => {
  await page.goto('/public/s_pub04');
  await expect(page.getByRole('heading', { name: 'データ削除請求' })).toBeVisible();
});
