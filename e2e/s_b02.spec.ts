import { test, expect } from '@playwright/test';

test.describe('S-B02 プロジェクトダッシュボード', () => {
  test('KPI セクションが表示される', async ({ page }) => {
    await page.goto('/projects/s_b02');
    await expect(page.getByRole('region', { name: 'KPI 一覧' })).toBeVisible();
  });
});
