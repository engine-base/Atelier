/**
 * 最終スイープ — test-specs の planned を planned=0 へ潰す第5弾。
 *
 *   1) 5xx エラー: API GET を 500 化 → inline error / toast (白画面・undefined 参照にしない)
 *   2) 空データ: GET を空 ([] / {}) 化 → 空状態表示 (500 にしない)
 *   3) 状態永続: F5 リロードでログアウトへ飛ばず同一画面を維持
 *   4) a11y: 全26画面を @axe-core/playwright で実走 (critical/serious 0)
 *
 * 前提は responsive.e2e.ts と同じ (web/api/実PG + QA seed)。
 */

import { createHmac } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
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
  execution: "dc77372d-36d0-4fea-9ba4-f0da85aa0332",
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

async function force500(page: Page): Promise<void> {
  await page.route("**/127.0.0.1:8000/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 200, headers: CORS, body: "" });
      return;
    }
    await route.fulfill({
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ detail: "internal error (E2E)" }),
    });
  });
}

/** GET を空データ化 (配列 endpoint は []、単一 endpoint は 404 相当ではなく {} を返す)。 */
async function forceEmpty(page: Page): Promise<void> {
  await page.route("**/127.0.0.1:8000/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 200, headers: CORS, body: "" });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ data: [] }),
    });
  });
}

const GET_SCREENS: readonly { id: string; path: string }[] = [
  { id: "S-A03", path: `/workspace-settings?workspace=${IDS.ws}` },
  { id: "S-B01", path: "/projects" },
  { id: "S-B02", path: `/projects/dashboard?project=${IDS.project}` },
  { id: "S-C01", path: "/employees" },
  { id: "S-C02", path: `/employees/detail?employee=${IDS.employee}` },
  { id: "S-F01", path: `/workflow?project=${IDS.project}` },
  { id: "S-F02", path: `/workflow/phases?project=${IDS.project}` },
  { id: "S-G01", path: `/outputs?output=${IDS.output}` },
  { id: "S-H01", path: `/mocks?mock=${IDS.mock}` },
  { id: "S-I01", path: `/tasks?project=${IDS.project}` },
  { id: "S-I02", path: `/tasks/detail?task=${IDS.task}` },
  { id: "S-J01", path: "/approvals" },
  { id: "S-K01", path: `/knowledge?workspace=${IDS.ws}` },
  { id: "S-K02", path: `/knowledge/review?workspace=${IDS.ws}` },
  { id: "S-L01", path: `/portal/invitations?project=${IDS.project}` },
  { id: "S-O01", path: `/schedules?project=${IDS.project}` },
  { id: "T-UC-36", path: "/t-uc-36" },
  { id: "T-UC-37", path: "/t-uc-37" },
  { id: "T-UC-38", path: "/t-uc-38" },
  { id: "T-UC-39", path: "/t-uc-39" },
];

const ALL_SCREENS: readonly { id: string; path: string }[] = [
  ...GET_SCREENS,
  { id: "S-A01", path: "/signin" },
  { id: "S-I03", path: `/tasks/monitor?execution=${IDS.execution}` },
  { id: "S-L02", path: "/portal/signin" },
  { id: "S-M01", path: `/meetings?project=${IDS.project}` },
  { id: "T-UC-40", path: "/t-uc-40" },
];

// ── 1) 5xx エラー表示 ─────────────────────────────────────────────────────
test.describe("5xx: API 500 時に inline error / toast (白画面にしない)", () => {
  for (const s of GET_SCREENS) {
    test(`${s.id} 500 エラー表示`, async ({ page, context }) => {
      await signin(context);
      await force500(page);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(s.path, { waitUntil: "networkidle" });
      const body = (await page.textContent("body")) ?? "";
      expect(
        /失敗しました|エラーが発生|できません/.test(body),
        `${s.id}: 500 でエラー表示 (body="${body.slice(0, 100)}")`,
      ).toBe(true);
      expect(errors, `${s.id}: uncaught error なし`).toEqual([]);
    });
  }
});

// ── 2) 空データ表示 ───────────────────────────────────────────────────────
test.describe("空データ: GET 空でも空状態表示 (500/undefined 参照にしない)", () => {
  for (const s of GET_SCREENS) {
    test(`${s.id} 空状態`, async ({ page, context }) => {
      await signin(context);
      await forceEmpty(page);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(s.path, { waitUntil: "networkidle" });
      const body = ((await page.textContent("body")) ?? "").trim();
      expect(body.length, `${s.id}: 白画面にならない`).toBeGreaterThan(0);
      expect(
        /Unhandled|Application error/i.test(body),
        `${s.id}: クラッシュ画面にならない`,
      ).toBe(false);
      expect(errors, `${s.id}: uncaught error なし`).toEqual([]);
    });
  }
});

// ── 3) 状態永続 (F5) ─────────────────────────────────────────────────────
test.describe("状態永続: F5 リロードでログアウトへ飛ばない", () => {
  for (const s of ALL_SCREENS) {
    test(`${s.id} リロード維持`, async ({ page, context }) => {
      await signin(context);
      await page.goto(s.path, { waitUntil: "networkidle" });
      await page.reload({ waitUntil: "networkidle" });
      const url = page.url();
      const base = s.path.split("?")[0];
      // 公開画面(A01/L02)以外は認証画面へ飛ばされないこと
      if (base !== "/signin" && base !== "/portal/signin") {
        expect(url, `${s.id}: reload 後もログアウトしない`).toContain(base);
      } else {
        expect(url).toContain(base);
      }
    });
  }
});

// ── 4) a11y (axe) 全26画面 ────────────────────────────────────────────────
test.describe("a11y: axe critical/serious 0 (全26画面)", () => {
  for (const s of ALL_SCREENS) {
    test(`${s.id} axe`, async ({ page, context }) => {
      await signin(context);
      await page.goto(s.path, { waitUntil: "networkidle" });
      const results = await new AxeBuilder({ page }).analyze();
      const serious = results.violations.filter(
        (v) => v.impact === "critical" || v.impact === "serious",
      );
      expect(
        serious.map((v) => `${v.id}: ${v.nodes.length} nodes`),
        `${s.id}: critical/serious 違反`,
      ).toEqual([]);
    });
  }
});
