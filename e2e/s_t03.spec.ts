import { test, expect } from '@playwright/test';

test('S-T03 AI 社員テンプレ', async ({ page }) => {
  await page.goto('/admin/s_t03');
  await expect(page.getByRole('heading', { name: 'AI 社員テンプレ' })).toBeVisible();
});
