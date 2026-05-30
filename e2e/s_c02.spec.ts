import { test, expect } from '@playwright/test';

test('S-C02 AI 社員詳細・編集', async ({ page }) => {
  await page.goto('/employees/s_c02');
  await expect(page.getByRole('heading', { name: 'AI 社員詳細・編集' })).toBeVisible();
});
