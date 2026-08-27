/**
 * GAP-234 — middleware の公開パス一覧に、実ルートの無いパスが残っていた。
 *
 * 通しの画面別消化 (SA01-026) で発見。`/signup` は middleware.ts の
 * PUBLIC_PATHS と ConditionalAppShell の bare 一覧に載っているのに、
 * ROUTE_MAP にも app/ にも実体が無く **404** になっていた
 * (サインアップ UI は S-A01 のタブなので、独立ルートが無かった)。
 * アプリ自身が「公開」と宣言するパスが 404 になるのは行き止まり。
 *
 * ここで固定するのは 2 つ:
 *   ① 公開パス一覧の各パスが ROUTE_MAP で実ルートに解決する (404 にならない)
 *   ② /signup は S-A01 (サインイン/サインアップ画面) に解決する
 *
 * この壊れ方の一般形は「宣言した公開パスと、実在するルートがずれる」。
 */

import { describe, expect, it } from "vitest";

import { ROUTE_MAP } from "../../lib/routes";

// middleware.ts / ConditionalAppShell.tsx が「公開」と宣言しているパス。
// (ビルド時定数の重複を避けるため、ここに検査対象として列挙する。)
const DECLARED_PUBLIC_PATHS = [
  "/signin",
  "/signup",
  "/workspace-settings",
  "/terms",
  "/privacy",
  "/tokushoho",
  "/data-deletion",
];

// rewrite を持たず素の app/ ルートで存在するもの (ROUTE_MAP に無くても実在)。
const NATIVE_ROUTES = new Set(["/"]);

describe("GAP-234 公開パスは実ルートに解決する", () => {
  const mapped = new Set(ROUTE_MAP.map(([clean]) => clean));

  for (const p of DECLARED_PUBLIC_PATHS) {
    it(`${p} は実ルートに解決する (404 にならない)`, () => {
      expect(mapped.has(p) || NATIVE_ROUTES.has(p)).toBe(true);
    });
  }

  it("/signup は S-A01 (サインイン/サインアップ画面) に解決する", () => {
    const entry = ROUTE_MAP.find(([clean]) => clean === "/signup");
    expect(entry).toBeDefined();
    expect(entry?.[1]).toBe("/auth/s_a01");
  });
});
