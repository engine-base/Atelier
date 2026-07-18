import { test, expect } from '@playwright/test';

test('S-F01 工程ワークフロー: フェーズ表示', async ({ page }) => {
  await page.goto('/workflow/s_f01');
  // 新デザイン(モック S-F01-flow 準拠)では見出しは sr-only + 工程ヘッダー構成
  await expect(page.getByRole('heading', { name: '工程ワークフロー' })).toBeAttached();
});
