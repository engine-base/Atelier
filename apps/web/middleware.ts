/**
 * Next.js middleware — T-US-03 (認証フロー配管)
 *
 * - public path 以外で atelier_access cookie が無い / 期限切れなら /signin にリダイレクト
 * - /portal/* は client_portal 用の別 cookie (atelier_client_access) を要求
 * - /admin/* は通常 authenticated JWT に加えて運営 (admin) を要求。
 *   **これは表示上の整理であって防御ではない** — ここでは署名を検証していないので、
 *   偽のトークンを作れば通り抜けられる。実際の防御は API 側で、運営専用 API は
 *   全て 403 を返す (GAP-219 で実測確認済み)。ここで止めるのは
 *   「権限が無い人に運営コンソールを組み立てて見せない」ため。
 * - middleware 自体は JWT 検証はせず exp 確認のみ。検証は API 側 (T-D-22 RLS で完成)
 *
 * パスは全て「意味的URL」(例 /projects, /portal/signin) で表現する。next.config の
 * redirects() が内部ルート(/projects/s_b01 等)を意味的URLへ 308 する順序が middleware より
 * 前なので、middleware に届くのは常に意味的URL。防御的に旧 /auth /client prefix も残す。
 */

import { NextResponse, type NextRequest } from 'next/server';

import { COOKIE_NAMES, decodeJwtUnsafe, isExpired, isPlatformAdmin } from './lib/auth/cookie';

/** middleware の処理対象外パス (公開資源: 認証前でも到達可能) */
const PUBLIC_PATHS: readonly string[] = [
  '/',
  '/signin',
  '/signup',
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

  // 運営コンソールは、運営でない人には組み立てない (GAP-219)。
  //
  // 以前はここに検査が無く (docstring には「owner role を要求」と書いてあったが
  // 実装されていなかった)、一般利用者が /admin を開くと 7 つのメニューを持つ
  // 運営コンソールがそのまま描画され、各パネルが個別に API を叩いて 403 を受け、
  // 同じ「権限がありません」が 11 件・約 7 秒間 出続けていた。
  //
  // redirect ではなく rewrite にしているのは、URL を書き換えて「別の場所へ
  // 飛ばされた」と誤解させないため。開いた URL のまま、説明と戻り道を出す。
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (!isPlatformAdmin(decodeJwtUnsafe(token))) {
      const url = req.nextUrl.clone();
      url.pathname = '/access-denied';
      url.search = '';
      return NextResponse.rewrite(url);
    }
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
