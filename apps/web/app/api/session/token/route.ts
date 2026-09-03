/**
 * GAP-261 — HttpOnly cookie のトークンを、**同一オリジンの JS にだけ**渡す。
 *
 * API は別オリジン (Fly) なので Authorization ヘッダーが要る。ブラウザは
 * これをメモリにだけ置き、`document.cookie` には書かない (書いた瞬間に
 * HttpOnly の意味が消える)。
 */

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { COOKIE_NAMES } from "../../../../lib/auth/cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(COOKIE_NAMES.access)?.value ?? null;
  return NextResponse.json(
    { data: { access_token: token } },
    // 保存させない (ブラウザ・中継のどちらにも残さない)
    { headers: { "Cache-Control": "no-store" } },
  );
}
