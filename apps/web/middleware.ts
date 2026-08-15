/**
 * Next.js middleware — T-US-03 (認証フロー配管)
 *
 * - public path 以外で atelier_access cookie が無い / 期限切れなら /signin にリダイレクト
 * - /portal/* は client_portal 用の別 cookie (atelier_client_access) を要求
 * - /admin/* は通常 authenticated JWT に加えて owner role を要求 (実 role 検査は API 側)
 * - middleware 自体は JWT 検証はせず exp 確認のみ。検証は API 側 (T-D-22 RLS で完成)
 *
 * パスは全て「意味的URL」(例 /projects, /portal/signin) で表現する。next.config の
 * redirects() が内部ルート(/projects/s_b01 等)を意味的URLへ 308 する順序が middleware より
 * 前なので、middleware に届くのは常に意味的URL。防御的に旧 /auth /client prefix も残す。
 */

import { NextResponse, type NextRequest } from 'next/server';

import { COOKIE_NAMES, decodeJwtUnsafe, isExpired } from './lib/auth/cookie';

/** middleware の処理対象外パス (公開資源: 認証前でも到達可能) */
const PUBLIC_PATHS: readonly string[] = [
  '/',
  '/signin',
  // '/signup' は PUBLIC_PATHS から外した (T-UC-47 / GAP-120)。
  // 実ルートが無いのに公開パス扱いだったため 404 に着地し、しかもその 404 が
  // hydration mismatch (#418) を起こしていた。下の SIGNUP_ALIAS で明示的に
  // /signin へ正規化する (サインアップは S-A01 のタブとして実装済み)。
  '/workspace-settings', // S-A03 ワークスペース初期設定 (サインアップ導線)
  '/terms', // S-PUB01
  '/privacy', // S-PUB02
  '/tokushoho', // S-PUB03
  '/data-deletion', // S-PUB04
  '/auth', // 防御的 (redirects 前に届いた場合の内部 prefix)
  '/public', // 同上
  '/_next',
  '/favicon.ico',
];

/**
 * 実ルートを持たない別名パス (T-UC-47 / GAP-120)。
 *
 * サインアップは S-A01 (`/signin`) の signup タブとして実装されており、
 * `/signup` という実ルートは存在しない。にもかかわらず PUBLIC_PATHS と
 * `ConditionalAppShell` の BARE_EXACT には載っていて、**実体の無いパスを
 * アプリが実在するものとして扱っていた**。到達すると Next 標準の 404 になり、
 * その 404 の SSR が AppShell 付き・client が bare で hydration mismatch (#418)
 * を起こしていた (server 側 usePathname は `/_not-found` を返すため)。
 */
const SIGNUP_ALIAS = '/signup';
const SIGNUP_TARGET = '/signin';

/** クライアントポータルの意味的 prefix (内部 /client) */
const CLIENT_PATH_PREFIX = '/portal';

/**
 * ポータル配下でも「社内ユーザー向け」の画面 (client cookie でなく通常 auth を要求)。
 * 招待管理 (/portal/invitations = S-L01) は PM が招待を発行する社内画面。client ガードに
 * 巻き込むと社内ユーザーが到達不能になり /portal/signin へ強制リダイレクトされる実バグがあった。
 */
const CLIENT_INTERNAL_PATHS: readonly string[] = ['/portal/invitations', '/client/s_l01'];

/** クライアントサインイン (ガードの着地先: cookie 不要) */
const CLIENT_SIGNIN_PATHS: readonly string[] = ['/portal/signin', '/client/s_l02'];

function matchesAny(pathname: string, list: readonly string[]): boolean {
  return list.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function isClientPath(pathname: string): boolean {
  return (
    pathname === CLIENT_PATH_PREFIX ||
    pathname.startsWith(`${CLIENT_PATH_PREFIX}/`) ||
    pathname === '/client' ||
    pathname.startsWith('/client/')
  );
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // /signup は実ルートを持たない (サインアップは S-A01 のタブ)。
  // 認証状態に関係なく、常にサインアップ面を持つ画面へ正規化する。
  // ここで先に返すことで 404 の描画そのものが起きなくなり、
  // 「404 ページの SSR は AppShell 付き / client は bare」で生じていた
  // hydration mismatch (#418) も構造的に消える (T-UC-47 / GAP-120)。
  if (pathname === SIGNUP_ALIAS) {
    const url = req.nextUrl.clone();
    url.pathname = SIGNUP_TARGET;
    // redirect パラメータは付けない。付けるとサインイン後に /signup へ戻り、
    // 再び正規化されるだけの無意味な往復になる。
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (matchesAny(pathname, PUBLIC_PATHS)) {
    return NextResponse.next();
  }

  // クライアントサインインはガードの着地先なので cookie 不要。
  // ガード対象に含めると cookie 無しアクセスが自分自身へ無限リダイレクトし、
  // クライアントがポータルに一切入れない実バグがあった。
  if (matchesAny(pathname, CLIENT_SIGNIN_PATHS)) {
    return NextResponse.next();
  }

  // /portal/* は client_portal cookie を要求 (社内向け画面 /portal/invitations は除く)
  if (!matchesAny(pathname, CLIENT_INTERNAL_PATHS) && isClientPath(pathname)) {
    const token = req.cookies.get(COOKIE_NAMES.clientAccess)?.value;
    if (!token || isExpired(decodeJwtUnsafe(token))) {
      const url = req.nextUrl.clone();
      url.pathname = '/portal/signin';
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
