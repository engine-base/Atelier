import { test, expect } from '@playwright/test';

test('S-K02 ナレッジ昇格レビュー', async ({ page }) => {
  await page.goto('/knowledge/s_k02');
  await expect(page.getByRole('heading', { name: 'ナレッジ昇格レビュー' })).toBeVisible();
});
