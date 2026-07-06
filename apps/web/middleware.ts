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
  '/public',
  '/_next',
  '/favicon.ico',
];

/** /client/* で要求される cookie */
const CLIENT_PATH_PREFIX = '/client';

/**
 * /client/ 配下でも「社内ユーザー向け」の画面 (client cookie でなく通常 auth を要求)。
 * S-L01 招待管理は PM が招待を発行する社内画面。client ガードに巻き込むと
 * 社内ユーザーが到達不能になり S-L02 へ強制リダイレクトされる実バグがあった。
 */
const CLIENT_INTERNAL_PATHS: readonly string[] = ['/client/s_l01'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isClientInternalPath(pathname: string): boolean {
  return CLIENT_INTERNAL_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // S-L02 (クライアントサインイン) はガードの着地先なので cookie 不要。
  // ガード対象に含めると cookie 無しアクセスが自分自身へ無限リダイレクトし、
  // クライアントがポータルに一切入れない実バグがあった。
  if (pathname === '/client/s_l02' || pathname.startsWith('/client/s_l02/')) {
    return NextResponse.next();
  }

  // /client/* は client_portal cookie を要求 (社内向け画面 S-L01 は除く)
  if (
    !isClientInternalPath(pathname) &&
    (pathname === CLIENT_PATH_PREFIX || pathname.startsWith(`${CLIENT_PATH_PREFIX}/`))
  ) {
    const token = req.cookies.get(COOKIE_NAMES.clientAccess)?.value;
    if (!token || isExpired(decodeJwtUnsafe(token))) {
      const url = req.nextUrl.clone();
      url.pathname = '/client/s_l02';
      url.searchParams.set('redirect', pathname);
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // それ以外は通常 atelier_access を要求
  const token = req.cookies.get(COOKIE_NAMES.access)?.value;
  if (!token || isExpired(decodeJwtUnsafe(token))) {
    const url = req.nextUrl.clone();
    url.pathname = '/auth/s_a01';
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
