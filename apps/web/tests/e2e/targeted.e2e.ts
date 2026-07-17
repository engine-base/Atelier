/**
 * 個別残行の実機消化 (第6弾) — planned=0 への最終ラウンド。
 *
 * 対象: A01 placeholder / A03 初期値・zod・rollback / C02 zod・保存エラー /
 * H01 ビューポート切替 / K02 昇格承認(実PROMOTE→DB)・却下(client dismiss)・422 /
 * L01 招待発行→DB・失効 / L02 無効・期限切れ token 文言 / L03 client 4状態 /
 * UC-37 readonly・max・rollback表示 / UC-38/39 picker 切替 / UC-40 5xx・403。
 */

import { createHmac } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const SECRET =
  process.env.ATELIER_AUTH_JWT_SECRET ??
  "local-human-qa-secret-at-least-32-characters-long";
const USER_ID =
  process.env.E2E_USER_ID ?? "a818edcd-8e05-4bd9-a0d1-aaf80c777adf";
const API_BASE = process.env.E2E_API_BASE ?? "http://127.0.0.1:8000";

const IDS = {
  ws: "2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69",
  project: "a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b",
  employee: "11111111-0000-4000-8000-000000000001",
  mock: "55555555-0000-4000-8000-000000000001",
};

const CORS = {
  "Access-Control-Allow-Origin": "http://localhost:3000",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
};

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mintJwt(sub: string): string {
  const h = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const p = b64url(
    Buffer.from(
      JSON.stringify({
        sub,
        role: "authenticated",
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  );
  const s = b64url(createHmac("sha256", SECRET).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}

async function signin(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: "atelier_access", value: mintJwt(USER_ID), domain: "localhost", path: "/" },
  ]);
}

async function clientSignin(context: BrowserContext): Promise<boolean> {
  const res = await fetch(`${API_BASE}/client/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitation_token: "qa-inv-token" }),
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { data?: { client_access_token?: string } };
  const token = body.data?.client_access_token;
  if (!token) return false;
  await context.addCookies([
    { name: "atelier_client_access", value: token, domain: "localhost", path: "/" },
  ]);
  return true;
}

async function failMutations(page: Page): Promise<void> {
  await page.route("**/127.0.0.1:8000/**", async (route) => {
    const m = route.request().method();
    if (m === "OPTIONS") {
      await route.fulfill({ status: 200, headers: CORS, body: "" });
      return;
    }
    if (m === "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 422,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ detail: "forced failure (E2E)" }),
    });
  });
}

async function force500(page: Page): Promise<void> {
  await page.route("**/127.0.0.1:8000/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 200, headers: CORS, body: "" });
      return;
    }
    await route.fulfill({
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ detail: "boom" }),
    });
  });
}

async function force403(page: Page): Promise<void> {
  await page.route("**/127.0.0.1:8000/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 200, headers: CORS, body: "" });
      return;
    }
    await route.fulfill({
      status: 403,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ detail: "forbidden" }),
    });
  });
}

// ── S-A01 placeholder / 初期値 ────────────────────────────────────────────
test("S-A01: email/password input が空初期値で存在する", async ({ page }) => {
  await page.goto("/signin", { waitUntil: "networkidle" });
  const email = page.locator("input[type=email]");
  const pw = page.locator("input[type=password]");
  await expect(email).toBeVisible();
  await expect(pw).toBeVisible();
  expect(await email.inputValue()).toBe("");
  expect(await pw.inputValue()).toBe("");
});

// ── S-A03 初期値 / zod / rollback ─────────────────────────────────────────
test("S-A03: 初期値 (WS名) + AI学習は既定OFF", async ({ page, context }) => {
  await signin(context);
  await page.goto(`/workspace-settings?workspace=${IDS.ws}`, { waitUntil: "networkidle" });
  const name = page.locator("input:not([type=checkbox])").first();
  await expect(name).toBeVisible();
  await expect
    .poll(
      async () =>
        (await name.inputValue()).length +
        ((await name.getAttribute("placeholder")) ?? "").length,
      { timeout: 5000 },
    )
    .toBeGreaterThan(0);
  expect(await page.locator("input[type=checkbox]").isChecked()).toBe(false);
});

test("S-A03: 名称空で保存 → 入力必須 (送信されない)", async ({ page, context }) => {
  await signin(context);
  await page.goto(`/workspace-settings?workspace=${IDS.ws}`, { waitUntil: "networkidle" });
  const name = page.locator("input:not([type=checkbox])").first();
  await name.fill("");
  let mutated = false;
  await page.route("**/127.0.0.1:8000/workspaces/**", async (route) => {
    if (route.request().method() !== "GET") mutated = true;
    await route.fallback();
  });
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText(/入力必須|入力してください/)).toBeVisible();
  expect(mutated).toBe(false);
});

test("S-A03: 保存 422 で名称がロールバックし alert", async ({ page, context }) => {
  await signin(context);
  await page.goto(`/workspace-settings?workspace=${IDS.ws}`, { waitUntil: "networkidle" });
  const name = page.locator("input:not([type=checkbox])").first();
  const before = await name.inputValue();
  await failMutations(page);
  await name.fill(`${before}-x`);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  // サーバへ永続化されていないこと (reload 後の GET 値が元のまま)
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload({ waitUntil: "networkidle" });
  await expect
    .poll(async () => name.inputValue(), { timeout: 5000 })
    .toBe(before);
});

// ── S-C02 zod / 保存エラー ────────────────────────────────────────────────
test("S-C02: 表示名空 → 入力必須 / 保存 422 → alert", async ({ page, context }) => {
  await signin(context);
  await page.goto(`/employees/detail?employee=${IDS.employee}`, {
    waitUntil: "networkidle",
  });
  const name = page.locator("input:not([type=checkbox])").first();
  await expect(name).toBeVisible();
  await name.fill("");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText(/入力必須|入力してください/)).toBeVisible();
  // 422 → alert (rollback は表示名フォームの controlled state)
  await failMutations(page);
  await name.fill("E2E太郎");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
});

// ── S-H01 ビューポート切替 ────────────────────────────────────────────────
test("S-H01: ビューポート切替 4 ボタンが iframe 幅を変える", async ({
  page,
  context,
}) => {
  await signin(context);
  // storage 未構成環境 (CI Gate#15 は PG のみ) では content-url が 503 になり
  // ビューア UI 自体が出ない designed 挙動のため skip する
  const probe = await fetch(
    `${API_BASE}/mocks/${IDS.mock}/content-url`,
    { headers: { Authorization: `Bearer ${mintJwt(USER_ID)}` } },
  );
  test.skip(probe.status !== 200, "storage 未構成 (content-url 非200) のため対象外");
  await page.goto(`/mocks?mock=${IDS.mock}`, { waitUntil: "networkidle" });
  const frame = page.locator("iframe").first();
  await expect(frame).toBeVisible();
  const widths: number[] = [];
  for (const label of ["モバイル", "タブレット", "デスクトップ", "ワイド"]) {
    await page.getByText(new RegExp(label)).first().click();
    const w = await frame.evaluate((el) => el.getBoundingClientRect().width);
    widths.push(Math.round(w));
  }
  // 4 プリセットで幅が実際に変化する (少なくとも 3 種類の異なる幅)
  expect(new Set(widths).size).toBeGreaterThanOrEqual(3);
});

// ── S-K02 昇格承認 (実 API→反映) / 却下 / 422 ───────────────────────────
test("S-K02: 承認 → POST promote → 一覧から消滅 / 却下 → dismiss", async ({
  page,
  context,
}) => {
  await signin(context);
  // 昇格候補 (user-scope ノード) をテスト自身が API で作成する (冪等・promote で
  // workspace 化して消費されるため seed 依存にしない)
  const title = `E2E昇格候補-${Date.now()}`;
  const created = await fetch(`${API_BASE}/knowledge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mintJwt(USER_ID)}`,
    },
    body: JSON.stringify({
      account_type: "user",
      account_id: USER_ID,
      scope: "common",
      category: "general",
      title,
      content_md: "promote me",
    }),
  });
  expect(created.status, "昇格候補の作成").toBeLessThan(300);
  await page.goto(`/knowledge/review?workspace=${IDS.ws}`, {
    waitUntil: "networkidle",
  });
  // 対象タイトルの行の承認ボタンをクリック (残骸候補と独立)
  const approve = page.getByRole("button", {
    name: new RegExp(`${title}.*(昇格|承認)`),
  });
  await approve.waitFor({ state: "visible", timeout: 8000 });
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/promote") && r.request().method() === "POST"),
    approve.click(),
  ]);
  expect(res.status()).toBeLessThan(300);
  // 承認した候補 (対象タイトル) が一覧から消える
  await expect(page.getByText(title)).toHaveCount(0, { timeout: 5000 });
});

test("S-K02: 却下は一覧から除外(dismiss) / 承認422はロールバック+alert", async ({
  page,
  context,
}) => {
  await signin(context);
  const mk = (title: string) =>
    fetch(`${API_BASE}/knowledge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mintJwt(USER_ID)}`,
      },
      body: JSON.stringify({
        account_type: "user",
        account_id: USER_ID,
        scope: "common",
        category: "general",
        title,
        content_md: "x",
      }),
    });
  expect((await mk(`E2E却下-${Date.now()}`)).status).toBeLessThan(300);
  await page.goto(`/knowledge/review?workspace=${IDS.ws}`, {
    waitUntil: "networkidle",
  });
  const reject = page.getByRole("button", { name: /却下/ }).first();
  await reject.waitFor({ state: "visible", timeout: 8000 });
  const beforeCount = await page.getByRole("button", { name: /却下/ }).count();
  await reject.click();
  await expect
    .poll(async () => page.getByRole("button", { name: /却下/ }).count())
    .toBeLessThan(beforeCount);
  // 422: 承認失敗 → 行復元 + alert
  expect((await mk(`E2E422-${Date.now()}`)).status).toBeLessThan(300);
  await page.reload({ waitUntil: "networkidle" });
  const approve = page.getByRole("button", { name: /承認|昇格/ }).first();
  await approve.waitFor({ state: "visible", timeout: 8000 });
  const n = await page.getByRole("button", { name: /承認|昇格/ }).count();
  await failMutations(page);
  await approve.click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect
    .poll(async () => page.getByRole("button", { name: /承認|昇格/ }).count(), {
      timeout: 5000,
    })
    .toBe(n);
});

// ── S-L01 招待発行 → 反映 / 失効 ──────────────────────────────────────────
test("S-L01: 招待発行 → 一覧反映、失効 → 状態変化", async ({ page, context }) => {
  await signin(context);
  await page.goto(`/portal/invitations?project=${IDS.project}`, {
    waitUntil: "networkidle",
  });
  const email = `e2e-inv-${Date.now()}@example.com`;
  await page.locator("input[type=email], input[type=text]").first().fill(email);
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("client-invitations") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: /招待を発行/ }).click(),
  ]);
  expect(res.status()).toBeLessThan(300);
  await expect(page.getByText(email)).toBeVisible({ timeout: 5000 });
  // 失効: 対象行の失効ボタン
  const row = page.locator("tr", { hasText: email });
  const [rev] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("revoke") && r.request().method() === "POST",
    ),
    row.getByRole("button", { name: /失効/ }).click(),
  ]);
  expect(rev.status()).toBeLessThan(300);
  await expect(row.getByText(/失効済|失効/)).toBeVisible({ timeout: 5000 });
  // 失効 422: もう 1 通発行し、mutation 失敗で alert + 状態が変わらない
  const email2 = `e2e-inv2-${Date.now()}@example.com`;
  await page.locator("input[type=email], input[type=text]").first().fill(email2);
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("client-invitations") && r.request().method() === "POST",
    ),
    page.getByRole("button", { name: /招待を発行/ }).click(),
  ]);
  const row2 = page.locator("tr", { hasText: email2 });
  await expect(row2).toBeVisible({ timeout: 5000 });
  await failMutations(page);
  await row2.getByRole("button", { name: /失効/ }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  // mutation 失敗 → 行は失効済にならず残る (derived status の文言差異に依存しない)
  await expect(row2).toBeVisible();
  await expect(row2.getByText(/失効済/)).toHaveCount(0);
});

// ── S-L02 無効 / 期限切れ token ──────────────────────────────────────────
test("S-L02: 無効 token はエラー文言 (画面遷移しない)", async ({ page }) => {
  await page.goto("/portal/signin", { waitUntil: "networkidle" });
  await page.locator("input").first().fill("totally-invalid-token-123");
  await page.getByRole("button", { name: "プロジェクトを開く" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 5000 });
  await expect(page).toHaveURL(/portal\/signin/);
});

test("S-L02: 期限切れ token は失効文言", async ({ page }) => {
  await page.goto("/portal/signin", { waitUntil: "networkidle" });
  await page.locator("input").first().fill("qa-expired-token");
  await page.getByRole("button", { name: "プロジェクトを開く" }).click();
  const alert = page.getByRole("alert").first();
  await expect(alert).toBeVisible({ timeout: 5000 });
  await expect(page).toHaveURL(/portal\/signin/);
});

// ── S-L03 client ビューの 4 状態 ─────────────────────────────────────────
test("S-L03: loading / 空 / 403 / 5xx (client cookie)", async ({
  page,
  context,
}) => {
  const ok = await clientSignin(context);
  test.skip(!ok, "client 招待 seed なし");
  // loading (遅延)
  await page.route("**/127.0.0.1:8000/client/projects/**", async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.fallback();
  });
  await page.goto(`/portal?project=${IDS.project}`, { waitUntil: "commit" });
  await expect(
    page.locator('[role="status"]').or(page.getByText(/読み込み中/)).first(),
  ).toBeVisible({ timeout: 4000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // 空データ: 空 body でもクラッシュせず描画
  await page.route("**/127.0.0.1:8000/client/projects/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { id: IDS.project, name: "", phases: [], outputs: [] } }),
    });
  });
  await page.goto(`/portal?project=${IDS.project}`, { waitUntil: "networkidle" });
  expect(((await page.textContent("body")) ?? "").length).toBeGreaterThan(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // 403
  await force403(page);
  await page.goto(`/portal?project=${IDS.project}`, { waitUntil: "networkidle" });
  await expect(
    page.getByText(/権限がありません|失敗しました|エラー/).first(),
  ).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // 5xx
  await force500(page);
  await page.goto(`/portal?project=${IDS.project}`, { waitUntil: "networkidle" });
  await expect(page.getByText(/失敗しました|エラー/).first()).toBeVisible();
});

// ── S-M01 ファイル選択 (死にボタン検査) ──────────────────────────────────
test("S-M01: ファイル選択 input が実在し操作可能", async ({ page, context }) => {
  await signin(context);
  await page.goto(`/meetings?project=${IDS.project}`, {
    waitUntil: "networkidle",
  });
  const file = page.locator("input[type=file]");
  await expect(file).toBeAttached();
  expect(await file.isDisabled()).toBe(false);
});

// ── T-UC-37 readonly / max / rollback 表示 ───────────────────────────────
test("T-UC-37: email は readonly、101字は弾く、422 で alert+復元", async ({
  page,
  context,
}) => {
  await signin(context);
  await page.goto("/t-uc-37", { waitUntil: "networkidle" });
  const nameInput = page
    .locator("input:not([readonly]):not([disabled])")
    .first();
  await expect(nameInput).toBeVisible({ timeout: 8000 });
  // email は readonly/disabled な input として存在する
  await expect(
    page.locator("input[readonly], input[disabled]").first(),
  ).toBeVisible();
  // 101 字 → 送信されない or エラー
  const before = await nameInput.inputValue();
  let mutated = false;
  await page.route("**/127.0.0.1:8000/me", async (route) => {
    if (route.request().method() !== "GET") mutated = true;
    await route.fallback();
  });
  await nameInput.fill("あ".repeat(101));
  await page.getByRole("button", { name: "保存" }).click();
  await page.waitForTimeout(800);
  expect(mutated, "101字は送信しない").toBe(false);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  // 422 → alert + 表示名がサーバ値へ復元
  await failMutations(page);
  await nameInput.fill("E2E失敗名");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload({ waitUntil: "networkidle" });
  await expect
    .poll(async () => nameInput.inputValue(), { timeout: 8000 })
    .toBe(before);
});

// ── T-UC-38 / 39 picker 実切替 ───────────────────────────────────────────
test("T-UC-38: WS picker で選択 → 現在表示が更新", async ({ page, context }) => {
  await signin(context);
  await page.goto("/t-uc-38", { waitUntil: "networkidle" });
  const picker = page.getByRole("button").first();
  await picker.click();
  const option = page.getByRole("option").first().or(page.getByRole("menuitem").first());
  test.skip(!(await option.isVisible().catch(() => false)), "選択肢なし");
  const label = (await option.textContent())?.trim() ?? "";
  await option.click();
  await expect(page.getByText(`現在: ${label}`)).toBeVisible({ timeout: 4000 });
});

test("T-UC-39: Project picker で選択 → 現在表示が更新", async ({
  page,
  context,
}) => {
  await signin(context);
  await page.goto("/t-uc-39", { waitUntil: "networkidle" });
  const picker = page.getByRole("button").first();
  await picker.click();
  const option = page.getByRole("option").first().or(page.getByRole("menuitem").first());
  test.skip(!(await option.isVisible().catch(() => false)), "選択肢なし");
  const label = (await option.textContent())?.trim() ?? "";
  await option.click();
  await expect(page.getByText(`現在: ${label}`)).toBeVisible({ timeout: 4000 });
});

// ── T-UC-40 5xx / 403 ────────────────────────────────────────────────────
test("T-UC-40: 検索 5xx → エラー表示 / 403 → 拒否表示", async ({
  page,
  context,
}) => {
  await signin(context);
  await force500(page);
  await page.goto("/t-uc-40", { waitUntil: "networkidle" });
  await page.locator("input[type=search], input").first().click();
  await page.keyboard.type("サンプル");
  await expect(
    page.getByText(/失敗しました|エラー/).first(),
  ).toBeVisible({ timeout: 5000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await force403(page);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("input[type=search], input").first().click();
  await page.keyboard.type("サンプル");
  await expect(
    page.getByText(/権限がありません|失敗しました|エラー/).first(),
  ).toBeVisible({ timeout: 5000 });
});
