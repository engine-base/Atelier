/**
 * GAP-327 — セッション cookie の受け渡し口を、門の外に出す。
 *
 * GAP-261 で「JWT は web オリジンの route handler が HttpOnly cookie で持つ」
 * 方式にしたが、**その route handler 自身が middleware の門の内側にいた**。
 *
 * 起きること (2026-09-04 本番実測):
 *
 *   POST https://<web>/api/session
 *   → HTTP/2 307
 *     location: /signin?redirect=%2Fapi%2Fsession
 *
 * サインイン直後はまだ cookie が無いので、**トークンを預ける POST が
 * サインイン画面へ送り返される**。cookie は保存されず、次の画面遷移で
 * middleware がまた /signin に戻す = **誰もサインインを完了できない**。
 *
 * GAP-261 の web 回帰は route handler を直接呼んでいたので、この経路
 * (ブラウザ → middleware → route handler) は一度も通っていなかった。
 * ここで固定するのは「門の外に居ること」そのもの。
 */

import { describe, expect, it } from "vitest";

import { middleware } from "../../middleware";

/** cookie を 1 つも持たない (= サインイン直後) リクエスト。 */
function anonymousRequest(pathname: string) {
  const url = new URL(`http://localhost:3100${pathname}`);
  return {
    nextUrl: Object.assign(url, { clone: () => new URL(url.toString()) }),
    cookies: { get: () => undefined },
  } as unknown as Parameters<typeof middleware>[0];
}

describe("GAP-327 /api/session は門の外", () => {
  for (const path of ["/api/session", "/api/session/token"]) {
    it(`cookie が無くても ${path} は /signin へ飛ばされない`, () => {
      const res = middleware(anonymousRequest(path));
      // redirect は Location を立てる。素通り (next) なら立たない。
      expect(
        res.headers.get("location"),
        `${path} が /signin へ 307 されている (サインインが完了できない)`,
      ).toBeNull();
      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    });
  }

  it("守るべき画面は今までどおり /signin へ飛ばす (門を開けすぎていない)", () => {
    const res = middleware(anonymousRequest("/projects"));
    const loc = res.headers.get("location");
    expect(loc).not.toBeNull();
    expect(new URL(loc!).pathname).toBe("/signin");
  });

  it("/api で始まるだけの別パスは公開しない (前方一致を広げすぎない)", () => {
    const res = middleware(anonymousRequest("/api/sessions-elsewhere"));
    const loc = res.headers.get("location");
    expect(loc).not.toBeNull();
    expect(new URL(loc!).pathname).toBe("/signin");
  });
});
