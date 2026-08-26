/**
 * GAP-219 — 運営コンソールを、運営でない人には組み立てない。
 *
 * 通しの第0群 (J00-03) で見つけた実挙動:
 *   一般利用者が /admin を開くと、7 つのメニューを持つ運営コンソールが
 *   そのまま描画され、各パネルが個別に API を叩いて 403 を受け、
 *   同じ「権限がありません」が **11 件・約 7 秒間** 出続けていた (実測)。
 *
 *   middleware の docstring には「/admin/* は owner role を要求」と
 *   書いてあったが、**実装が入っていなかった**。説明だけが先に存在していた。
 *
 * ここで固定するのは 2 つ:
 *   ① 運営でない人の /admin は運営コンソールを組み立てず、説明の画面に差し替わる
 *   ② 運営の人は素通りする (門を付けたせいで運営が入れなくなっていないか)
 *
 * なお **これは防御ではない**。middleware は署名を検証していないので、偽の
 * トークンを作れば通り抜けられる。実際の防御は API 側 (403) で、そちらは
 * 通しで全エンドポイントの 403 を実測している。ここで見るのは表示の整理だけ。
 */

import { describe, expect, it } from "vitest";

import { decodeJwtUnsafe, isPlatformAdmin } from "../../lib/auth/cookie";
import { middleware } from "../../middleware";

/** 署名は使わないので、payload だけ本物と同じ形にした token を組み立てる。 */
function fakeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.signature`;
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600;

const adminToken = fakeToken({
  sub: "u-admin",
  exp: FUTURE,
  role: "authenticated",
  app_metadata: { role: "admin" },
});
const memberToken = fakeToken({
  sub: "u-member",
  exp: FUTURE,
  role: "authenticated",
  app_metadata: { provider: "email" },
});

/** middleware に渡す最小の NextRequest 相当。 */
function request(pathname: string, token: string) {
  const url = new URL(`http://localhost:3100${pathname}`);
  return {
    nextUrl: Object.assign(url, { clone: () => new URL(url.toString()) }),
    cookies: {
      get: (name: string) =>
        name === "atelier_access" ? { value: token } : undefined,
    },
  } as unknown as Parameters<typeof middleware>[0];
}

describe("isPlatformAdmin", () => {
  it("app_metadata.role が admin なら true", () => {
    expect(isPlatformAdmin(decodeJwtUnsafe(adminToken))).toBe(true);
  });

  it("一般利用者は false", () => {
    expect(isPlatformAdmin(decodeJwtUnsafe(memberToken))).toBe(false);
  });

  it("Postgres のロール名 (role: authenticated) を運営と誤認しない", () => {
    const t = fakeToken({ sub: "u", exp: FUTURE, role: "admin" });
    expect(isPlatformAdmin(decodeJwtUnsafe(t))).toBe(false);
  });

  it("トークンが読めなければ false (安全側に倒す)", () => {
    expect(isPlatformAdmin(decodeJwtUnsafe("not-a-jwt"))).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
  });
});

describe("/admin の門", () => {
  for (const path of ["/admin", "/admin/skills", "/admin/design-templates/x"]) {
    it(`一般利用者の ${path} は運営コンソールを組み立てない`, () => {
      const res = middleware(request(path, memberToken));
      const rewritten = res.headers.get("x-middleware-rewrite");
      expect(rewritten, "rewrite されていない").not.toBeNull();
      expect(new URL(rewritten!).pathname).toBe("/access-denied");
    });

    it(`運営の ${path} は素通りする`, () => {
      const res = middleware(request(path, adminToken));
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
      expect(res.headers.get("location")).toBeNull();
    });
  }

  it("運営でない人でも、運営以外の画面はこの門に巻き込まれない", () => {
    const res = middleware(request("/projects", memberToken));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
  });

  it("/administration のような別のパスを巻き込まない", () => {
    const res = middleware(request("/administration", memberToken));
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});
