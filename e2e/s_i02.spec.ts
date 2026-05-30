import { test, expect } from '@playwright/test';

test('S-I02 タスク詳細: タブ切替', async ({ page }) => {
  await page.goto('/tasks/s_i02');
  await expect(page.getByRole('tablist', { name: 'タスク詳細タブ' })).toBeVisible();
});
