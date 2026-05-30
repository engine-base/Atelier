import { test, expect } from '@playwright/test';

/**
 * S-A01 サインイン/サインアップ画面 E2E — T-UC-01
 *
 * 本ファイルはスキャフォルド。詳細な axe scan / keyboard nav は T-I-10 で
 * @axe-core/playwright を統合した後に充実させる。
 */

test.describe('S-A01 サインイン/サインアップ', () => {
  test('signin タブと signup タブが切替可能', async ({ page }) => {
    await page.goto('/auth/s_a01');
    await expect(page.getByRole('heading', { name: 'サインイン' })).toBeVisible();
    await page.getByRole('tab', { name: 'サインアップ' }).click();
    await expect(page.getByRole('heading', { name: 'サインアップ' })).toBeVisible();
  });
});
