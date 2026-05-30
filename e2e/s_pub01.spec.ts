import { test, expect } from '@playwright/test';

test('S-PUB01 利用規約', async ({ page }) => {
  await page.goto('/public/s_pub01');
  await expect(page.getByRole('heading', { name: '利用規約' })).toBeVisible();
});
