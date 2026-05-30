/**
 * Next.js middleware — T-US-03 (認証フロー配管)
 *
 * - public path 以外で atelier_access cookie が無い / 期限切れなら /signin にリダイレクト
 * - /client/* は client_portal 用の別 cookie (atelier_client_access) を要求
 * - /admin/* は通常 authenticated JWT に加えて owner role を要求 (実 role 検査は API 側)
 * - middleware 自体は JWT 検証はせず exp 確認のみ。検証は API 側 (T-D-22 RLS で完成)
 */

import { NextResponse, type NextRequest } from 'next/server';

import { COOKIE_NAMES, decodeJwtUnsafe, isExpired } from './lib/auth/cookie';

/** middleware の処理対象外パス (公開資源) */
const PUBLIC_PATHS: readonly string[] = [
  '/',
  '/signin',
  '/signup',
  '/auth',
  '/_next',
  '/favicon.ico',
];

/** /client/* で要求される cookie */
const CLIENT_PATH_PREFIX = '/client';

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // /client/* は client_portal cookie を要求
  if (pathname === CLIENT_PATH_PREFIX || pathname.startsWith(`${CLIENT_PATH_PREFIX}/`)) {
    const token = req.cookies.get(COOKIE_NAMES.clientAccess)?.value;
    if (!token || isExpired(decodeJwtUnsafe(token))) {
      const url = req.nextUrl.clone();
      url.pathname = '/signin';
      url.searchParams.set('redirect', pathname);
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // それ以外は通常 atelier_access を要求
  const token = req.cookies.get(COOKIE_NAMES.access)?.value;
  if (!token || isExpired(decodeJwtUnsafe(token))) {
    const url = req.nextUrl.clone();
    url.pathname = '/signin';
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

/**
 * Matcher: 静的資産と _next/* 系を除外。他は middleware を通す。
 * (next/server の `config.matcher` で配列指定)
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
