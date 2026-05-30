import { test, expect } from '@playwright/test';

test('S-C01 AI 社員組織図', async ({ page }) => {
  await page.goto('/employees/s_c01');
  await expect(page.getByRole('heading', { name: 'AI 社員組織図' })).toBeVisible();
});
