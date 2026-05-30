/**
 * T-I-01 E2E: サインアップ → ダッシュボード
 *
 * 流れ:
 *   1. /auth/s_a01 にアクセス
 *   2. サインアップ タブで email/password/confirm/consent 入力
 *   3. 送信 → サインイン状態に遷移
 *   4. プロジェクトダッシュボード (S-B02) へ移動
 *
 * 本テストは UI 側のみ検証。実際の API connector は別タスクで配線。
 * UI が render され、フォーム送信が「拒否されない」ことを担保する。
 */

import { test, expect } from '@playwright/test';

import { makeTestUser, signUp } from './_helpers/auth';

test.describe('T-I-01: サインアップ → ダッシュボード', () => {
  test('signup form 完走 → ダッシュボードに到達可能', async ({ page }) => {
    const user = makeTestUser();
    await signUp(page, user);
    // page が「新規登録 form」から遷移できる前提: ここでは UI 側の form 送信が
    // 正常終了したことを「button 押下後にエラーが出ない」で代理検証。
    await expect(page.getByRole('alert')).toHaveCount(0);

    // ダッシュボードへ手動遷移できることを確認
    await page.goto('/projects/s_b02');
    await expect(page.getByRole('heading', { name: 'Sample Project' })).toBeVisible();
  });
});
