import { test, expect } from '@playwright/test';

/**
 * S-L02 クライアントサインイン E2E — T-UC-21 (R-T08 関連)
 */

test.describe('S-L02 クライアントサインイン', () => {
  test('招待トークン入力フォームが表示される', async ({ page }) => {
    await page.goto('/client/s_l02');
    await expect(page.getByRole('heading', { name: 'クライアントサインイン' })).toBeVisible();
  });
});
