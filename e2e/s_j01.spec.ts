import { test, expect } from '@playwright/test';

test('S-J01 承認待ち: 一覧表示', async ({ page }) => {
  await page.goto('/approvals/s_j01');
  await expect(page.getByRole('heading', { name: '承認待ち' })).toBeVisible();
});
