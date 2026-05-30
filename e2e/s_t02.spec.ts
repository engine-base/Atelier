import { test, expect } from '@playwright/test';

test('S-T02 スキル管理', async ({ page }) => {
  await page.goto('/admin/s_t02');
  await expect(page.getByRole('heading', { name: 'スキル管理' })).toBeVisible();
});
