import { test, expect } from '@playwright/test';

test('S-I01 タスクボード: 6 列表示', async ({ page }) => {
  await page.goto('/tasks/s_i01');
  await expect(page.getByRole('group', { name: 'タスクボード' })).toBeVisible();
});
