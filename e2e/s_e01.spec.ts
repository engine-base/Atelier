import { test, expect } from '@playwright/test';

test('S-E01 チャット + 工程文脈バー', async ({ page }) => {
  await page.goto('/chat/s_e01');
  await expect(page.getByRole('region', { name: 'チャット' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '工程文脈' })).toBeVisible();
});
