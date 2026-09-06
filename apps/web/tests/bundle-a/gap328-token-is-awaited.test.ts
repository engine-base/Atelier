/**
 * GAP-328 — API 呼び出しの Authorization を **同期読みで組まない**。
 *
 * GAP-261 で JWT を HttpOnly cookie に移した結果、`document.cookie` からは
 * 読めなくなった。画面を読み込んだ直後のメモリの控えは空なので、同期の
 * `readAccessToken()` で Authorization を組むと **ヘッダー無しで飛んで 401**、
 * 全体エラー処理でサインイン画面に跳ね返される。
 *
 * 本番同等の実測 (ローカルに web+API+実 PG を立てて実ブラウザ):
 *
 *   REQ  GET /me/consents            auth=NO   -> 401
 *   REQ  GET /workspaces             auth=NO   -> 401
 *   REQ  GET /me                     auth=NO   -> 401
 *   REQ  GET /approval-inbox         auth=NO   -> 401
 *   final url: /signin?redirect=/projects
 *
 * つまり **サインインできても、画面を読み込み直した瞬間に追い出される**。
 * ここで固定するのは「その形の同期読みが production コードに戻ってこない」こと。
 * (実挙動そのものは e2e の signin-roundtrip が見る)
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const TARGET_DIRS = ["app", "components", "lib", "providers", "hooks"];

/** 定義元だけは同期読みを持ってよい (古い素 cookie の利用者を拾うため)。 */
const ALLOWED = new Set([join("lib", "auth", "connector.ts")]);

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full));
    } else if (/\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe("GAP-328 トークンは待ってから使う", () => {
  it("production コードが readAccessToken() を呼んでいない", () => {
    const offenders: string[] = [];
    for (const dir of TARGET_DIRS) {
      let files: string[] = [];
      try {
        files = walk(join(ROOT, dir));
      } catch {
        continue; // 無いディレクトリは飛ばす
      }
      for (const file of files) {
        const rel = file.slice(ROOT.length + 1);
        if (ALLOWED.has(rel)) continue;
        const body = readFileSync(file, "utf-8");
        // 呼び出し (readAccessToken() ) だけを見る。import 名だけの一致は拾わない。
        if (/\breadAccessToken\s*\(/.test(body)) offenders.push(rel);
      }
    }
    expect(
      offenders,
      "同期読みで Authorization を組むと、読み込み直後に 401 で追い出される。await ensureAccessToken() を使う",
    ).toEqual([]);
  });
});
