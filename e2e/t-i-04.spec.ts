/**
 * T-I-04 E2E: 退会 → 30 日後 hard delete
 *
 * 本フローは:
 *   1. S-PUB04 データ削除請求 form を表示
 *   2. email + 確認 + reason + consent を入力
 *   3. 送信 → form が拒否されないこと (実 API 連携は別 PR)
 *
 * 30 日 grace + hard delete の実 logic は API 側 T-A-XX で完成済 (F-LEGAL-007)。
 * 本 E2E は UI 側の form 完走を担保する。
 */

import { test, expect } from '@playwright/test';

test.describe('T-I-04: 退会 → 30 日後 hard delete', () => {
  test('S-PUB04 削除請求フォームの送信完走', async ({ page }) => {
    await page.goto('/public/s_pub04');
    await expect(page.getByRole('heading', { name: 'データ削除請求' })).toBeVisible();

    const emailInputs = page.getByLabel(/^メールアドレス/);
    await emailInputs.nth(0).fill('delete-me@example.com');
    await emailInputs.nth(1).fill('delete-me@example.com');
    await page.getByLabel(/理由/).fill('退会のため');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '削除請求を送信' }).click();

    // 送信後に error alert が出ないこと
    await expect(page.getByRole('alert')).toHaveCount(0);

    // 30 日 grace の説明文が画面に存在する (F-LEGAL-007 表記の整合性)
    await expect(page.getByText(/30 日後の完全削除/)).toBeVisible();
  });
});
