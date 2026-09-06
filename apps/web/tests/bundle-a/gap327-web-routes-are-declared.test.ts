/**
 * GAP-327 の一般化 — **web 自身の route handler を足したら、門の内外を必ず決める。**
 *
 * GAP-327 は `/api/session` (GAP-261 で新設) が middleware の門の内側に入ったまま
 * 本番に出て、**誰もサインインできなくなった**事故だった。原因は「門を足した/経路を
 * 足したときに、まだ入っていない人が通る必要のある口を数え直さなかった」こと。
 *
 * 個別の 1 本 (gap327-session-route-is-public) だけでは、**次に足す route handler**
 * で同じことが起きる。ここでは `app/api/**\/route.ts` を機械的に数え、1 本ずつ
 *
 *   - 門の外 (未サインインでも通る) か
 *   - 門の内側でよい (下の GUARDED に理由つきで書く)
 *
 * のどちらかであることを強制する。新しい route を足した人は、どちらかを選ぶまで
 * このテストが落ちる。
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { middleware } from "../../middleware";

const API_DIR = join(__dirname, "..", "..", "app", "api");

/**
 * 門の内側でよい route (未サインインでは使わせない)。
 * **足すときは理由を書く** — 書けないなら、たぶん門の外に出すべき。
 */
const GUARDED: Record<string, string> = {};

function routePaths(dir: string, prefix = "/api"): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out = out.concat(routePaths(full, `${prefix}/${name}`));
    } else if (name === "route.ts" || name === "route.tsx") {
      out.push(prefix);
    }
  }
  return out;
}

function anonymousRequest(pathname: string) {
  const url = new URL(`http://localhost:3100${pathname}`);
  return {
    nextUrl: Object.assign(url, { clone: () => new URL(url.toString()) }),
    cookies: { get: () => undefined },
  } as unknown as Parameters<typeof middleware>[0];
}

describe("GAP-327 web の route handler は門の内外を宣言する", () => {
  const paths = routePaths(API_DIR);

  it("route handler が 1 本以上見つかる (検査が空振りしていない)", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  for (const path of paths) {
    it(`${path} は門の外 (または GUARDED に理由つきで登録されている)`, () => {
      const res = middleware(anonymousRequest(path));
      const redirected = res.headers.get("location") !== null;
      if (path in GUARDED) {
        expect(
          redirected,
          `${path} は GUARDED (${GUARDED[path]}) なのに門の外に出ている`,
        ).toBe(true);
        return;
      }
      expect(
        redirected,
        `${path} が /signin へ 307 される。未サインインで通す必要があるなら ` +
          `middleware.ts の PUBLIC_PATHS に足す。通す必要が無いなら、このテストの ` +
          `GUARDED に理由つきで登録する`,
      ).toBe(false);
    });
  }
});
