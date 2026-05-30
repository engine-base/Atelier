import { test, expect } from '@playwright/test';

test('S-H01 モックビューア: ビューポート切替', async ({ page }) => {
  await page.goto('/mocks/s_h01');
  await expect(page.getByRole('group', { name: 'ビューポート切替' })).toBeVisible();
});
