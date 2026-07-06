/**
 * エラー経路の実機検証 — test-specs の planned を機械消化する第2弾。
 *
 *   1) 権限 403: API GET を route-interception で 403 に差し替え、各画面が
 *      「権限がありません」系の拒否表示を出すこと (500/白画面にしない)。
 *   2) 楽観更新ロールバック: mutation を 422 に差し替え、楽観反映が元に戻り
 *      エラー表示が出ること (UNWANTED critical)。
 *
 * 前提は responsive.e2e.ts と同じ (web/api/実PG + QA seed)。
 */

import { createHmac } from "node:crypto";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const SECRET =
  process.env.ATELIER_AUTH_JWT_SECRET ??
  "local-human-qa-secret-at-least-32-characters-long";
const USER_ID =
  process.env.E2E_USER_ID ?? "a818edcd-8e05-4bd9-a0d1-aaf80c777adf";

const IDS = {
  ws: "2d2345c1-b0a8-4ea1-a5bd-d80bac1b7b69",
  project: "a5dc7390-30c5-4084-9eb2-af6f7b1c1c1b",
  employee: "11111111-0000-4000-8000-000000000001",
  task: "2834763b-dd83-4f27-9d55-b02d33cf9841",
  output: "55555555-0000-4000-8000-000000000002",
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
    {
      name: "atelier_access",
      value: mintJwt(USER_ID),
      domain: "localhost",
      path: "/",
    },
  ]);
}

/** API への GET を全部 403 化 (OPTIONS は CORS 200)。 */
async function force403(page: Page): Promise<void> {
  await page.route("**/127.0.0.1:8000/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") {
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

/** mutation (POST/PATCH/PUT/DELETE) のみ 422 化。GET は実サーバへ。 */
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

// ── 1) 権限 403 sweep ─────────────────────────────────────────────────────
const SCREENS_403: readonly { id: string; path: string }[] = [
  { id: "S-A03", path: `/auth/s_a03?workspace=${IDS.ws}` },
  { id: "S-B01", path: "/projects/s_b01" },
  { id: "S-B02", path: `/projects/s_b02?project=${IDS.project}` },
  { id: "S-C01", path: "/employees/s_c01" },
  { id: "S-C02", path: `/employees/s_c02?employee=${IDS.employee}` },
  { id: "S-F01", path: `/workflow/s_f01?project=${IDS.project}` },
  { id: "S-F02", path: `/workflow/s_f02?project=${IDS.project}` },
  { id: "S-G01", path: `/outputs/s_g01?output=${IDS.output}` },
  { id: "S-H01", path: `/mocks/s_h01?mock=${IDS.mock}` },
  { id: "S-I01", path: `/tasks/s_i01?project=${IDS.project}` },
  { id: "S-I02", path: `/tasks/s_i02?task=${IDS.task}` },
  { id: "S-J01", path: "/approvals/s_j01" },
  { id: "S-K01", path: `/knowledge/s_k01?workspace=${IDS.ws}` },
  { id: "S-K02", path: `/knowledge/s_k02?workspace=${IDS.ws}` },
  { id: "S-L01", path: `/client/s_l01?project=${IDS.project}` },
  // S-M01 は初期 GET を持たない (アップロード起点画面) ため 403 sweep 対象外
  { id: "S-O01", path: `/cron/s_o01?project=${IDS.project}` },
  { id: "T-UC-36", path: "/t-uc-36" },
  { id: "T-UC-37", path: "/t-uc-37" },
  { id: "T-UC-38", path: "/t-uc-38" },
  { id: "T-UC-39", path: "/t-uc-39" },
];

test.describe("権限 403: API 403 時に拒否表示 (500/白画面にしない)", () => {
  for (const s of SCREENS_403) {
    test(`${s.id} 403 拒否表示`, async ({ page, context }) => {
      await signin(context);
      await force403(page);
      await page.goto(s.path, { waitUntil: "networkidle" });
      const body = (await page.textContent("body")) ?? "";
      expect(
        /権限がありません|失敗しました|エラーが発生/.test(body),
        `${s.id}: 403 で拒否/エラー表示が出ること (body="${body.slice(0, 120)}")`,
      ).toBe(true);
    });
  }
});

// ── 2) 楽観更新ロールバック ────────────────────────────────────────────────
test("S-O01 トグル: 422 で楽観反映がロールバックし alert 表示", async ({
  page,
  context,
}) => {
  await signin(context);
  await page.goto(`/cron/s_o01?project=${IDS.project}`, {
    waitUntil: "networkidle",
  });
  const toggle = page.locator("input[type=checkbox]").first();
  await expect(toggle).toBeVisible();
  const before = await toggle.isChecked();
  await failMutations(page);
  await toggle.click();
  // onError で元へ戻る
  await expect
    .poll(async () => toggle.isChecked(), { timeout: 5000 })
    .toBe(before);
  await expect(page.getByRole("alert").first()).toBeVisible();
});

test("S-F02 状態select: 422 でロールバックし alert 表示", async ({
  page,
  context,
}) => {
  await signin(context);
  await page.goto(`/workflow/s_f02?project=${IDS.project}`, {
    waitUntil: "networkidle",
  });
  const select = page.locator("select").last();
  await expect(select).toBeVisible();
  const before = await select.inputValue();
  const next = before === "pending" ? "in_progress" : "pending";
  await failMutations(page);
  await select.selectOption(next);
  await expect.poll(async () => select.inputValue(), { timeout: 5000 }).toBe(
    before,
  );
  await expect(page.getByRole("alert").first()).toBeVisible();
});

test("S-J01 承認: 422 で行が復元され alert 表示", async ({ page, context }) => {
  await signin(context);
  await page.goto("/approvals/s_j01", { waitUntil: "networkidle" });
  const approveButtons = page.getByRole("button", { name: /を承認$/ });
  const count = await approveButtons.count();
  test.skip(count === 0, "承認待ち seed が無い環境");
  await failMutations(page);
  await approveButtons.first().click();
  // 楽観除外 → onError で復元される
  await expect
    .poll(async () => approveButtons.count(), { timeout: 5000 })
    .toBe(count);
  await expect(page.getByRole("alert").first()).toBeVisible();
});
