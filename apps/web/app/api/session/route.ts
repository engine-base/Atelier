/**
 * GAP-261 — セッション cookie を **JS から読めない (HttpOnly)** 場所に移す。
 *
 * これまで JWT は `document.cookie` で書いていたので、XSS が 1 つでもあれば
 * そのまま盗めた (通し J10-03。正本の期待は「HTTP-only cookie で JWT 発行」)。
 *
 * web は Vercel・API は Fly で **別オリジン**なので、API が Set-Cookie を返す案は
 * 3rd-party cookie 扱いになり Safari で既定拒否 = 使えない。そこで web オリジンの
 * route handler (ここ) が cookie を持つ:
 *
 *   - POST   /api/session        サインイン直後にトークンを預ける (HttpOnly で保存)
 *   - DELETE /api/session        サインアウトで捨てる
 *   - GET    /api/session/token  同一オリジンからだけ、Authorization 用に取り出す
 *
 * cookie 名と形式は据え置き (middleware.ts はこの cookie を読んで画面を守る)。
 * ブラウザ側はメモリにだけ持ち、`document.cookie` には二度と書かない。
 *
 * 限界を正直に書いておく: XSS はこの route を呼べば短命トークンを取れる。
 * ここで消えるのは「**保存された資格情報がそのまま抜かれる**」ことで、
 * 別オリジン構成のまま完全に閉じるには API を同一サイト (独自ドメインの
 * api.<domain>) に置くしかない。ADR-022 に記録。
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { COOKIE_NAMES } from "../../../lib/auth/cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** JWT の形 (3 セグメント) だけ確かめる。中身の検証は API 側 (署名を持つのは API)。 */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_CHARS = 4096;

export async function POST(req: Request): Promise<NextResponse> {
  let body: { access_token?: unknown; expires_at?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ detail: "不正なリクエストです。" }, { status: 400 });
  }
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS || !JWT_SHAPE.test(token)) {
    return NextResponse.json({ detail: "不正なトークンです。" }, { status: 400 });
  }
  const expiresAt =
    typeof body.expires_at === "string" ? new Date(body.expires_at) : new Date(NaN);
  const store = await cookies();
  store.set(COOKIE_NAMES.access, token, {
    httpOnly: true,
    sameSite: "lax",
    // ローカル (http) では secure を付けると保存されない
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(Number.isNaN(expiresAt.getTime()) ? {} : { expires: expiresAt }),
  });
  return NextResponse.json({ data: { stored: true } });
}

export async function DELETE(): Promise<NextResponse> {
  const store = await cookies();
  store.set(COOKIE_NAMES.access, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(0),
  });
  return NextResponse.json({ data: { cleared: true } });
}
