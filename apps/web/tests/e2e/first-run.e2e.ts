/**
 * 登録直後の初回体験を、実ブラウザで最後まで通す (通し J15-01 / J10-07)。
 *
 * 正本 TUC35-901 と SB01-901 は、どちらも **新しく登録した人にしか出ない画面**
 * が対象で、cookie を注入して始める既存の e2e では踏めなかった。
 *
 *   TUC35-901 登録直後に /t-uc-35 が出る。最後に「完了」があり、押すと中の画面へ。
 *             以後は出ない (localStorage atelier_walkthrough_done)
 *   SB01-901  ワークスペース名を空のまま送ると
 *             「ワークスペース名を入力してください。」が出て、POST /workspaces は
 *             呼ばれず一覧も増えない
 */

import { expect, test } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const DONE_KEY = "atelier_walkthrough_done";

function freshEmail(): string {
  return `qa-first-${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}@example.com`;
}

test.describe("登録直後の初回体験", () => {
  test("TUC35-901 / SB01-901: ウォークスルー → 完了 → 空のワークスペース名は理由が出る", async ({
    page,
  }) => {
    const email = freshEmail();
    const password = "qa-first-run-password";

    // ── 登録する ────────────────────────────────────────────────
    await page.goto("/signup");
    await page.locator('input[type="email"]').fill(email);
    const pw = page.locator('input[type="password"]');
    await pw.nth(0).fill(password);
    await pw.nth(1).fill(password);
    await page.locator('input[type="checkbox"]').first().check();
    await page.locator('button[type="submit"]').click();

    // ── TUC35-901: 登録直後にウォークスルーが出る ─────────────────
    await page.waitForURL(/\/t-uc-35/, { timeout: 30_000 });
    expect(await page.evaluate((k) => localStorage.getItem(k), DONE_KEY)).toBeNull();

    // 3 ステップ進めると最後は「完了」
    await page.getByRole("button", { name: "次へ" }).click();
    await page.getByRole("button", { name: "次へ" }).click();
    const finish = page.getByRole("button", { name: "完了" });
    await expect(finish, "最後のステップに「完了」が無い").toBeVisible();
    await finish.click();

    // 押すと中の画面へ。完了が記録される
    await page.waitForURL((u) => !u.pathname.startsWith("/t-uc-35"), {
      timeout: 30_000,
    });
    expect(
      await page.evaluate((k) => localStorage.getItem(k), DONE_KEY),
      "完了が記録されていない (次も出てしまう)",
    ).toBe("1");

    // 以後は出ない (直接開いても素通りできる = 記録が効いている)
    await page.goto("/projects");
    expect(new URL(page.url()).pathname).not.toContain("/t-uc-35");

    // ── SB01-901: 空のワークスペース名は理由が出る ─────────────────
    // 登録直後はワークスペースが 0 件なので、この画面に作成欄が出る。
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/workspaces")) {
        posts.push(r.url());
      }
    });
    const create = page.getByRole("button", { name: /ワークスペースを作成|作成/ });
    await expect(create.first(), "ワークスペース作成の導線が無い").toBeVisible({
      timeout: 30_000,
    });
    await create.first().click();

    await expect(
      page.getByText("ワークスペース名を入力してください。"),
      "空のまま送っても理由が出ない",
    ).toBeVisible({ timeout: 10_000 });
    expect(posts, "POST /workspaces が呼ばれている").toEqual([]);
  });
});
