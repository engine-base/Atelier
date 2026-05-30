import { test, expect } from '@playwright/test';

test.describe('S-B01 プロジェクト一覧', () => {
  test('一覧見出しが表示される', async ({ page }) => {
    await page.goto('/projects/s_b01');
    await expect(page.getByRole('heading', { name: 'プロジェクト一覧' })).toBeVisible();
  });
});
