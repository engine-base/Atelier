import { test, expect } from '@playwright/test';

test('S-PUB03 特商法表記', async ({ page }) => {
  await page.goto('/public/s_pub03');
  await expect(page.getByRole('heading', { name: '特定商取引法に基づく表記' })).toBeVisible();
});
