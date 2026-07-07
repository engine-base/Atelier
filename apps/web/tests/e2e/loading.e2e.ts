/**
 * loading skeleton 表示 — test-specs 各画面「データ取得 loading」行の機械消化。
 *
 * API GET を route-interception で 800ms 遅延させ、取得完了前に
 * <Loading>(role=status) か Suspense fallback(読み込み中) が表示されることを検証。
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

/** API GET を遅延させる (レスポンスは実サーバ)。 */
async function delayGets(page: Page, ms: number): Promise<void> {
  await page.route("**/127.0.0.1:8000/**", async (route) => {
    if (route.request().method() === "GET") {
      await new Promise((r) => setTimeout(r, ms));
    }
    await route.fallback();
  });
}

/** GET を持つ画面 (S-M01 はアップロード起点のため対象外)。 */
const SCREENS: readonly { id: string; path: string }[] = [
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
  { id: "S-O01", path: `/cron/s_o01?project=${IDS.project}` },
  { id: "T-UC-36", path: "/t-uc-36" },
  { id: "T-UC-37", path: "/t-uc-37" },
  { id: "T-UC-38", path: "/t-uc-38" },
  { id: "T-UC-39", path: "/t-uc-39" },
];

test.describe("loading: GET 遅延中に role=status / 読み込み中 が表示される", () => {
  for (const s of SCREENS) {
    test(`${s.id} loading 表示`, async ({ page, context }) => {
      await signin(context);
      await delayGets(page, 1200);
      await page.goto(s.path, { waitUntil: "commit" });
      const indicator = page
        .locator('[role="status"], [aria-busy="true"]')
        .or(page.getByText(/読み込み中/))
        .first();
      await expect(
        indicator,
        `${s.id}: 取得完了前に loading 表示が出ること`,
      ).toBeVisible({ timeout: 4000 });
    });
  }
});
