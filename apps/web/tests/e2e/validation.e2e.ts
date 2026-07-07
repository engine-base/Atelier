/**
 * フィールドバリデーション — test-specs「バリデーション」行の実機消化。
 *
 * 期待文言は実装の zod スキーマ (SignupForm 等) が正解源。
 * ブラウザネイティブの required/type=email を通過する値で zod 層を発火させる。
 */

import { expect, test, type Page } from "@playwright/test";

async function gotoSignup(page: Page): Promise<void> {
  await page.goto("/auth/s_a01", { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "新規登録" }).click();
}

test("S-A01 新規登録: パスワード確認不一致で「パスワード確認が一致しません」", async ({
  page,
}) => {
  await gotoSignup(page);
  await page.locator("input[type=email]").fill("qa-val@example.com");
  await page.locator("input[type=password]").first().fill("Password!123");
  await page.locator("input[type=password]").nth(1).fill("Password!999");
  await page.locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "新規登録" }).click();
  await expect(page.getByText("パスワード確認が一致しません")).toBeVisible();
});

test("S-A01 新規登録: 同意なしで「同意が必要です」", async ({ page }) => {
  await gotoSignup(page);
  await page.locator("input[type=email]").fill("qa-val@example.com");
  await page.locator("input[type=password]").first().fill("Password!123");
  await page.locator("input[type=password]").nth(1).fill("Password!123");
  await page.getByRole("button", { name: "新規登録" }).click();
  await expect(
    page.getByText("利用規約とプライバシーポリシーへの同意が必要です"),
  ).toBeVisible();
});

test("S-A01 新規登録: メール形式エラー（zod 層）", async ({ page }) => {
  await gotoSignup(page);
  // "a@b" はブラウザの type=email は通るが zod .email() では不正
  await page.locator("input[type=email]").fill("a@b");
  await page.locator("input[type=password]").first().fill("Password!123");
  await page.locator("input[type=password]").nth(1).fill("Password!123");
  await page.locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "新規登録" }).click();
  await expect(
    page.getByText("メール形式で入力してください"),
  ).toBeVisible();
});

test("S-L02 クライアントサインイン: トークン未入力は zod が弾き API を呼ばない", async ({
  page,
}) => {
  await page.goto("/client/s_l02", { waitUntil: "networkidle" });
  let apiCalled = false;
  await page.route("**/127.0.0.1:8000/client/auth/**", async (route) => {
    apiCalled = true;
    await route.fallback();
  });
  await page.getByRole("button", { name: "プロジェクトを開く" }).click();
  // zod min(10) が弾き、エラー表示 + API 未呼び出し + 画面遷移なし
  await expect(
    page.locator("text=/at least 10|10文字|入力/").first(),
  ).toBeVisible({ timeout: 4000 });
  expect(apiCalled, "未入力では API を呼ばないこと").toBe(false);
  await expect(page).toHaveURL(/s_l02/);
});
