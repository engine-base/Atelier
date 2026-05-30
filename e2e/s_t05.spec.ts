import { test, expect } from '@playwright/test';

test('S-T05 監査ログ', async ({ page }) => {
  await page.goto('/admin/s_t05');
  await expect(page.getByRole('heading', { name: '監査ログ' })).toBeVisible();
});
