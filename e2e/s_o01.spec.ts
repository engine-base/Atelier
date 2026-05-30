import { test, expect } from '@playwright/test';

test('S-O01 自動スケジュール', async ({ page }) => {
  await page.goto('/cron/s_o01');
  await expect(page.getByRole('heading', { name: '自動スケジュール' })).toBeVisible();
});
