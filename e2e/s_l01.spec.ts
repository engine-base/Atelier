import { test, expect } from '@playwright/test';

test('S-L01 クライアント招待管理', async ({ page }) => {
  await page.goto('/client/s_l01');
  await expect(page.getByRole('heading', { name: 'クライアント招待管理' })).toBeVisible();
});
