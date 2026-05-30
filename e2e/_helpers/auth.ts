/**
 * E2E test helpers — common auth flow shortcuts.
 *
 * 本ヘルパは UI 操作経由でのサインアップ/サインイン手順を集約する。
 * 各 spec で同じステップを再記述するのを避け、変更点の波及を最小化。
 */

import { type Page, expect } from '@playwright/test';

export interface TestUser {
  readonly email: string;
  readonly password: string;
}

/** ランダムな test user を生成 */
export function makeTestUser(): TestUser {
  const id = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    email: `e2e-${id}@example.com`,
    password: 'P@ssword12345',
  };
}

/** S-A01 でサインアップフローを完走する */
export async function signUp(page: Page, user: TestUser): Promise<void> {
  await page.goto('/auth/s_a01');
  await page.getByRole('tab', { name: '新規登録' }).click();
  await expect(page.getByRole('heading', { name: '新規登録' })).toBeVisible();
  await page.getByLabel(/メールアドレス/).fill(user.email);
  // 「パスワード」が 2 つあるので first / nth で限定
  const passwordInputs = page.getByLabel(/^パスワード/);
  await passwordInputs.nth(0).fill(user.password);
  await page.getByLabel(/パスワード確認/).fill(user.password);
  await page.getByLabel(/利用規約とプライバシーポリシーに同意します/).check();
  await page.getByRole('button', { name: '新規登録' }).click();
}

/** S-A01 のサインインタブからサインインする */
export async function signIn(page: Page, user: TestUser): Promise<void> {
  await page.goto('/auth/s_a01');
  await page.getByRole('tab', { name: 'サインイン' }).click();
  await page.getByLabel(/メールアドレス/).fill(user.email);
  await page.getByLabel(/^パスワード/).fill(user.password);
  await page.getByRole('button', { name: 'サインイン' }).click();
}
