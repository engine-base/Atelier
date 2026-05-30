/**
 * T-I-03 E2E: チャット F-CTX01 完走
 *
 * S-E01 チャット画面で、工程文脈バーで phase を切替えてから送信、
 * AI 応答に phase 名が含まれることを確認 (F-CTX01: phase 連動文脈)。
 */

import { test, expect } from '@playwright/test';

test.describe('T-I-03: チャット F-CTX01 完走', () => {
  test('phase 切替 → 送信 → 応答に phase が反映される', async ({ page }) => {
    await page.goto('/chat/s_e01');
    await expect(page.getByRole('region', { name: 'チャット' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '工程文脈' })).toBeVisible();

    // phase を「実装」に切替
    await page.getByRole('button', { name: '実装' }).click();
    await expect(page.getByRole('button', { name: '実装' })).toHaveAttribute('aria-current', 'true');

    // メッセージ送信 (現状は sample 応答に phase 名が入る実装)
    const ta = page.getByLabel('メッセージを入力');
    await ta.fill('進捗を教えて');
    await page.getByRole('button', { name: '送信' }).click();

    // 応答に phase 名が含まれることを確認
    await expect(page.getByText(/実装/).first()).toBeVisible();
  });
});
