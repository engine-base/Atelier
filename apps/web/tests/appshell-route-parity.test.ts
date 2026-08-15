/**
 * T-UC-46: bare 判定が「意味的 URL」と「内部ルート」で一致することの機械検証 (GAP-116)。
 *
 * next.config の rewrites により `/signin` は `/auth/s_a01` を serve する。このとき
 * **サーバ側の `usePathname()` は内部ルート、クライアント側は URL バーの意味的 URL**を
 * 返すため、bare リストが意味的 URL しか持っていないと SSR と client で AppShell の
 * 有無が食い違い、hydration mismatch (React #418) になる。
 *
 * **7 件を手書きで列挙せず ROUTE_MAP を全走査する。**
 * 手書きだと ROUTE_MAP にエントリが増えたときに同じ穴が復活する。実際、初回調査では
 * `/portal/invitations` を不一致と誤判定していた (portal 分岐の除外条件を再実装で
 * 落としたため)。実装の `isBare` をそのまま呼ぶことでこの種の取り違えも防ぐ。
 */

import { describe, expect, it } from 'vitest';

import { isBare, normalizePath } from '../components/layout/ConditionalAppShell';
import { ROUTE_MAP } from '../lib/routes';

describe('ROUTE_MAP 全エントリの bare 判定 parity (T-UC-46)', () => {
  it('ROUTE_MAP が空でない (走査対象があること)', () => {
    expect(ROUTE_MAP.length).toBeGreaterThan(0);
  });

  it.each(ROUTE_MAP.map(([clean, internal]) => ({ clean, internal })))(
    '$clean と $internal で isBare が一致する',
    ({ clean, internal }) => {
      expect(isBare(internal)).toBe(isBare(clean));
    },
  );

  it('全エントリを 1 度に突き合わせても不一致 0 件', () => {
    const mismatches = ROUTE_MAP.filter(([clean, internal]) => isBare(clean) !== isBare(internal)).map(
      ([clean, internal]) => `${clean} -> ${internal}`,
    );

    expect(mismatches).toEqual([]);
  });
});

describe('normalizePath (T-UC-46)', () => {
  it.each(ROUTE_MAP.map(([clean, internal]) => ({ clean, internal })))(
    '内部ルート $internal を意味的 URL $clean へ正規化する',
    ({ clean, internal }) => {
      expect(normalizePath(internal)).toBe(clean);
    },
  );

  it('意味的 URL はそのまま返す (client 側の判定を変えない)', () => {
    for (const [clean] of ROUTE_MAP) {
      expect(normalizePath(clean)).toBe(clean);
    }
  });

  it('未知のパスはそのまま返す', () => {
    expect(normalizePath('/not-in-route-map')).toBe('/not-in-route-map');
    expect(normalizePath('/')).toBe('/');
  });

  it('冪等 (2 回かけても同じ)', () => {
    for (const [, internal] of ROUTE_MAP) {
      expect(normalizePath(normalizePath(internal))).toBe(normalizePath(internal));
    }
  });
});

describe('bare 判定そのものは変えていない (T-UC-46 UNWANTED critical)', () => {
  // client 側 (= ユーザーに見えている挙動) の期待値。修正の副作用でここが変わったら不合格。
  const EXPECTED_BARE: ReadonlyArray<readonly [string, boolean]> = [
    ['/', true],
    ['/signin', true],
    ['/signup', true],
    ['/terms', true],
    ['/privacy', true],
    ['/tokushoho', true],
    ['/data-deletion', true],
    ['/admin', true],
    ['/admin/skills', true],
    // BARE_PREFIXES の '/t-uc' は `=== '/t-uc'` か `'/t-uc/'` 前方一致のみ拾うため、
    // `/t-uc-36` は現状 **非 bare** (AppShell が付く)。意図的かは別途要確認だが、
    // 本タスクは bare 判定を変えないことが UNWANTED AC なので現状値で固定する。
    ['/t-uc-36', false],
    ['/portal', true],
    ['/portal/signin', true],
    // 社内向け招待管理だけは主シェルを付ける (既存の意図的な例外)
    ['/portal/invitations', false],
    ['/projects', false],
    ['/tasks', false],
    ['/chat', false],
    ['/workflow', false],
    ['/knowledge', false],
    ['/approvals', false],
    ['/workspace-settings', false],
  ];

  it.each(EXPECTED_BARE)('isBare(%s) === %s', (pathname, expected) => {
    expect(isBare(pathname)).toBe(expected);
  });

  it('/admin と /portal/invitations は従来どおり (tier_3 で明示された 2 件)', () => {
    expect(isBare('/admin')).toBe(true);
    expect(isBare('/admin/s_t01')).toBe(true);
    expect(isBare('/portal/invitations')).toBe(false);
    expect(isBare('/client/s_l01')).toBe(false);
  });
});
