import { test, expect } from '@playwright/test';

test('S-T04 ユーザー管理', async ({ page }) => {
  await page.goto('/admin/s_t04');
  await expect(page.getByRole('heading', { name: 'ユーザー管理' })).toBeVisible();
});
