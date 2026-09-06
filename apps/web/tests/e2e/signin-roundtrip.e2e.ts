/**
 * GAP-327 — **画面からのサインインを、実際に最後まで通す。**
 *
 * これまでの E2E は全部 `context.addCookies` で `atelier_access` を注入して
 * 始めていた。つまり
 *
 *   サインイン画面 → API → POST /api/session → cookie → 保護画面
 *
 * という経路を **一度も通していなかった**。だから GAP-261 で
 * `/api/session` を新設したとき、それが middleware の門の内側に入って
 * 307 で跳ね返されていても、CI は 17 ゲート全部緑のまま本番に出た
 * (本番実測: POST /api/session -> 307 /signin。**誰もサインインできない**)。
 *
 * ここで固定するのは「入口が本当に通ること」そのもの:
 *   ① フォームから入って保護画面に着く (門・route handler・cookie が全部繋がっている)
 *   ② その cookie は **JS から読めない** (GAP-261 の HttpOnly / 正本 SA01-901・907)
 *   ③ 読み直しても入ったままでいる (cookie が本当に保存されている)
 *   ④ サインアウトすると消え、保護画面は入口へ戻る (正本 SA01-908 / G-14)
 *
 * 前提は他の e2e と同じ (web + api + 実 PG + e2e-seed)。
 */

import { expect, test } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "qahuman@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "qa-e2e-password";
const COOKIE = "atelier_access";

test.describe.configure({ timeout: 90_000 });

test.describe("GAP-327 サインインの往復", () => {
  test("フォームから入って保護画面に着き、cookie は JS から読めない", async ({
    page,
    context,
  }) => {
    await page.goto("/signin");
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();

    // ① 入口を抜けたか。/signin に留まっていたら、その時点で入口が塞がっている。
    await page.waitForURL((url) => !url.pathname.startsWith("/signin"), {
      timeout: 30_000,
    });
    const errorBanner = page.locator('[role="alert"]');
    if (await errorBanner.count()) {
      expect(
        await errorBanner.first().innerText(),
        "サインインでエラーが出ている",
      ).not.toMatch(/失敗|できません|違います/);
    }

    // ② cookie は在るのに、JS からは見えない (これが GAP-261 の要点)
    const stored = (await context.cookies()).find((c) => c.name === COOKIE);
    expect(stored, `${COOKIE} が保存されていない`).toBeTruthy();
    expect(stored?.httpOnly, "HttpOnly が付いていない").toBe(true);
    expect(String(stored?.sameSite).toLowerCase()).toBe("lax");
    const visible = await page.evaluate(() => document.cookie);
    expect(visible, "JS から JWT が読める").not.toContain(COOKIE);

    // ③ 読み直しても入ったまま (cookie が本当に効いている)
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/);
  });

  test("サインアウトすると cookie が消え、保護画面は入口へ戻る", async ({
    page,
    context,
  }) => {
    await page.goto("/signin");
    await page.locator('input[type="email"]').fill(EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.startsWith("/signin"), {
      timeout: 30_000,
    });

    await page.goto("/projects");
    await page.getByRole("button", { name: /^アカウント: / }).click();
    await page.getByRole("menuitem", { name: "サインアウト" }).click();

    await page.waitForURL(/\/signin/, { timeout: 30_000 });
    const left = (await context.cookies()).find(
      (c) => c.name === COOKIE && c.value !== "",
    );
    expect(left, "サインアウトしても cookie が残っている").toBeFalsy();

    // 保護画面は入口へ戻る (共有 PC で前の人のセッションが残らない)
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/signin/);
  });
});
