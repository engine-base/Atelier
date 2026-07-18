import { test, expect } from '@playwright/test';

test('S-E01 チャット: 3ペイン構成の見出しとスレッド一覧', async ({ page }) => {
  await page.goto('/chat/s_e01');
  // 新デザイン(モック S-E01-thread 準拠): sr-only h1 + スレッド一覧ペイン
  await expect(page.getByRole('heading', { name: 'チャット' })).toBeAttached();
  await expect(
    page.getByRole('complementary', { name: 'スレッド一覧' }),
  ).toBeVisible();
});
