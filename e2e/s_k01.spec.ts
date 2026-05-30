import { test, expect } from '@playwright/test';

test('S-K01 ナレッジエクスプローラ', async ({ page }) => {
  await page.goto('/knowledge/s_k01');
  await expect(page.getByRole('heading', { name: 'ナレッジエクスプローラ' })).toBeVisible();
});
