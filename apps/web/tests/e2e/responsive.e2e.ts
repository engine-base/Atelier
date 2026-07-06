/**
 * 第8軸/レスポンシブ — 全26画面 × 4幅 (320/768/1024/1440) で横オーバーフローが
 * 無いことを実ブラウザで検証する (test-specs 各画面の「レスポンシブ」TC を消化)。
 *
 * 認証: API と同じ HS256 secret で JWT を発行し atelier_access cookie を直接設定
 * (client portal 画面は /client/auth/signin で client_access_token を取得)。
 * データ: scripts/ci/pg-bootstrap.sql + apply-migrations.sh 適用済みの実 PG に
 * QA seed (ws/project/task 等) が入っていること。無い画面は空状態でも
 * 「レイアウトが崩れない」ことは検証できるため、到達 200 + 非オーバーフローを assert。
 */

import { createHmac } from "node:crypto";

import { expect, test, type BrowserContext } from "@playwright/test";

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
  task: "2834763b-dd83-4f27-9d55-b02d33cf9841",
  output: "55555555-0000-4000-8000-000000000002",
  mock: "55555555-0000-4000-8000-000000000001",
  execution: "dc77372d-36d0-4fea-9ba4-f0da85aa0332",
};

/** 画面ID → ルート (実データ seed の id を含む) */
const SCREENS: readonly { id: string; path: string; client?: boolean }[] = [
  { id: "S-A01", path: "/auth/s_a01" },
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
  { id: "S-I03", path: `/tasks/s_i03?execution=${IDS.execution}` },
  { id: "S-J01", path: "/approvals/s_j01" },
  { id: "S-K01", path: `/knowledge/s_k01?workspace=${IDS.ws}` },
  { id: "S-K02", path: `/knowledge/s_k02?workspace=${IDS.ws}` },
  { id: "S-L01", path: `/client/s_l01?project=${IDS.project}` },
  { id: "S-L02", path: "/client/s_l02" },
  { id: "S-L03", path: `/client/s_l03?project=${IDS.project}`, client: true },
  { id: "S-M01", path: `/upload/s_m01?project=${IDS.project}` },
  { id: "S-O01", path: `/cron/s_o01?project=${IDS.project}` },
  { id: "T-UC-36", path: "/t-uc-36" },
  { id: "T-UC-37", path: "/t-uc-37" },
  { id: "T-UC-38", path: "/t-uc-38" },
  { id: "T-UC-39", path: "/t-uc-39" },
  { id: "T-UC-40", path: "/t-uc-40" },
];

const WIDTHS = [320, 768, 1024, 1440] as const;

function b64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mintJwt(sub: string): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        sub,
        role: "authenticated",
        aud: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  );
  const sig = b64url(
    createHmac("sha256", SECRET).update(`${header}.${payload}`).digest(),
  );
  return `${header}.${payload}.${sig}`;
}

async function setAuthCookies(context: BrowserContext): Promise<void> {
  const cookies = [
    {
      name: "atelier_access",
      value: mintJwt(USER_ID),
      domain: "localhost",
      path: "/",
    },
  ];
  // client portal 用 token (招待 seed が無い環境では skip し、middleware が
  // L02 サインインへ流すため L03 は L02 のレイアウト検証になる)
  try {
    const res = await fetch(`${API_BASE}/client/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitation_token: "qa-inv-token" }),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        data?: { client_access_token?: string };
      };
      const token = body.data?.client_access_token;
      if (token) {
        cookies.push({
          name: "atelier_client_access",
          value: token,
          domain: "localhost",
          path: "/",
        });
      }
    }
  } catch {
    // API 停止時はこの spec 全体が接続エラーで落ちるためここでは握る
  }
  await context.addCookies(cookies);
}

test.describe("レスポンシブ: 全26画面 × 320/768/1024/1440 で横オーバーフロー無し", () => {
  for (const screen of SCREENS) {
    test(`${screen.id} ${screen.path.split("?")[0]}`, async ({ page, context }) => {
      await setAuthCookies(context);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        const res = await page.goto(screen.path, { waitUntil: "networkidle" });
        expect(res, `${screen.id} @${width} navigation`).not.toBeNull();
        expect(
          res?.status(),
          `${screen.id} @${width} HTTP status`,
        ).toBeLessThan(400);
        const overflow = await page.evaluate(() => {
          const el = document.documentElement;
          return el.scrollWidth - el.clientWidth;
        });
        expect(
          overflow,
          `${screen.id} @${width}px: 横オーバーフロー ${overflow}px`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});
