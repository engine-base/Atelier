import { test, expect } from '@playwright/test';

test('S-PUB02 プライバシーポリシー', async ({ page }) => {
  await page.goto('/public/s_pub02');
  await expect(page.getByRole('heading', { name: 'プライバシーポリシー' })).toBeVisible();
});
