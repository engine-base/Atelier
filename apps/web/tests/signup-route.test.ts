/**
 * T-UC-47: `/signup` の扱いを 1 つに定める (GAP-120)。
 *
 * **元の異常**: `apps/web/app` に signup ディレクトリが無く `ROUTE_MAP` にも登録が無いのに、
 * `middleware.ts` の PUBLIC_PATHS と `ConditionalAppShell` の BARE_EXACT には `/signup` が
 * 載っていた = **実体の無いパスをアプリが実在するものとして扱っていた**。
 *
 * **#418 の機序** (T-UC-46 とは別物。実測で特定):
 * `/signup` は公開パス扱いのまま Next 標準の 404 に着地する。その 404 の
 * **SSR は AppShell 付き**で描画されるのに、**client は bare** で描画されるため
 * hydration mismatch になっていた。
 *   - SSR HTML: `<div class="flex min-h-dvh w-full bg-surface text-on-surface">` が存在
 *   - 実ブラウザの DOM: 同要素なし (body は script + Next の 404 表示のみ)
 *   - 原因: 404 では **server 側の usePathname() が `/_not-found` を返す** ため
 *     `isBare()` が false (AppShell 付き)、client は `/signup` なので BARE_EXACT に
 *     一致して true (bare) になる。SSR ペイロードに `_not-found` が含まれることも確認済み。
 *   ※ T-UC-46 の正規化では解けない — `/signup` は ROUTE_MAP に無いので
 *     normalizePath が恒等写像になり、両側とも `/signup` として一致してしまうため。
 *
 * **採った決着**: 「S-A01 の signup タブへ正規化」。middleware が `/signup` を
 * `/signin` へ redirect する。404 の描画そのものが起きなくなるので #418 も構造的に消え、
 * かつ死にパスでもなくなる (サインアップ面に到達できる)。
 */

import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { middleware } from '../middleware';

const ORIGIN = 'https://app.example.com';

function request(path: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(new URL(path, ORIGIN));
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

function locationOf(res: Response): URL | null {
  const location = res.headers.get('location');
  return location === null ? null : new URL(location);
}

describe('/signup の正規化 (T-UC-47)', () => {
  it('サインアップ面を持つ画面へ redirect する (死にパスにしない)', () => {
    const res = middleware(request('/signup'));

    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(locationOf(res)?.pathname).toBe('/signin');
  });

  it('redirect パラメータを付けない (サインイン後に /signup へ戻る往復を作らない)', () => {
    const res = middleware(request('/signup?redirect=%2Fprojects'));

    const url = locationOf(res);
    expect(url?.pathname).toBe('/signin');
    expect(url?.searchParams.get('redirect')).toBeNull();
    expect(url?.search).toBe('');
  });

  it('認証済みでも同じく正規化する (実ルートが無いことに変わりはない)', () => {
    const res = middleware(request('/signup', { atelier_access: 'dummy' }));

    expect(locationOf(res)?.pathname).toBe('/signin');
  });

  it('404 を返さない (元の異常は 404 着地だった)', () => {
    const res = middleware(request('/signup'));

    expect(res.status).not.toBe(404);
  });
});

describe('他パスの挙動を変えていない (T-UC-47 tier_3)', () => {
  it('/signin は従来どおり素通し', () => {
    const res = middleware(request('/signin'));

    expect(locationOf(res)).toBeNull();
  });

  it.each(['/terms', '/privacy', '/tokushoho', '/data-deletion', '/'])(
    '公開パス %s は従来どおり素通し',
    (path) => {
      expect(locationOf(middleware(request(path)))).toBeNull();
    },
  );

  it('保護ルートは未認証だと従来どおり /signin?redirect= へ', () => {
    const res = middleware(request('/projects'));

    const url = locationOf(res);
    expect(url?.pathname).toBe('/signin');
    expect(url?.searchParams.get('redirect')).toBe('/projects');
  });

  it('クライアントポータルの導線は従来どおり', () => {
    expect(locationOf(middleware(request('/portal/signin')))).toBeNull();

    const guarded = locationOf(middleware(request('/portal')));
    expect(guarded?.pathname).toBe('/portal/signin');
  });
});

describe('/signup が公開パス扱いのまま放置されていない (T-UC-47 tier_1)', () => {
  it('PUBLIC_PATHS の素通しではなく明示的な redirect で処理される', () => {
    // 公開パスなら location ヘッダが無い。/signup は redirect されること =
    // 「公開パス扱いだが実体が無い」中途半端な状態が残っていないこと。
    const signup = middleware(request('/signup'));
    const publicPath = middleware(request('/terms'));

    expect(locationOf(signup)).not.toBeNull();
    expect(locationOf(publicPath)).toBeNull();
  });
});
