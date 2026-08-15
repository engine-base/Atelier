/**
 * T-UC-46: /signin の hydration mismatch (React #418) の回帰テスト。
 *
 * 原因は `usePathname()` が **SSR では内部ルート (`/auth/s_a01`)、client では
 * 意味的 URL (`/signin`)** を返すのに、`ConditionalAppShell` の bare 判定が
 * 意味的 URL しか持っていなかったこと。結果、SSR は AppShell 付き・client は bare で
 * 描画され、DOM が食い違っていた (実測: SSR の body 直下に
 * `<div class="flex min-h-dvh …">` があるのに client には無い)。
 *
 * ここでは **同じツリーを「サーバが見るパス」と「クライアントが見るパス」の両方で
 * 描画し、AppShell の有無が一致する**ことを検証する。
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pathname } = vi.hoisted(() => ({ pathname: { current: '/signin' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

vi.mock('../lib/auth/connector', () => ({
  getJson: async () => ({ data: [] }),
}));

import { ConditionalAppShell } from '../components/layout/ConditionalAppShell';

/** AppShell が描画されたか (シェルのルート要素の有無で判定)。 */
function hasAppShell(container: HTMLElement): boolean {
  return container.querySelector('.min-h-dvh.w-full.bg-surface') !== null;
}

function renderAt(path: string) {
  pathname.current = path;
  return render(
    <ConditionalAppShell>
      <p>page-content</p>
    </ConditionalAppShell>,
  );
}

beforeEach(() => {
  pathname.current = '/signin';
});

describe('/signin の SSR/client parity (T-UC-46)', () => {
  it('意味的 URL でも内部ルートでも AppShell の有無が一致する', () => {
    const client = renderAt('/signin');
    const clientHasShell = hasAppShell(client.container);
    client.unmount();

    const server = renderAt('/auth/s_a01');
    const serverHasShell = hasAppShell(server.container);

    expect(serverHasShell).toBe(clientHasShell);
    // /signin は bare なので、どちらも AppShell 無しであること
    expect(clientHasShell).toBe(false);
  });

  it('どちらのパスでも子要素は描画される', () => {
    renderAt('/auth/s_a01');
    expect(screen.getByText('page-content')).toBeInTheDocument();
  });
});

describe('修正で影響を受けた 7 経路 (T-UC-46)', () => {
  // PM が ROUTE_MAP 全 35 件を機械照合して確定した不一致 7 件。
  // 網羅の担保は appshell-route-parity.test.ts (全走査) が持つ。ここは
  // 「実際に壊れていた経路」を名指しで固定する回帰。
  const AFFECTED: ReadonlyArray<readonly [string, string]> = [
    ['/signin', '/auth/s_a01'],
    ['/portal/signin', '/client/s_l02'],
    ['/portal', '/client/s_l03'],
    ['/terms', '/public/s_pub01'],
    ['/privacy', '/public/s_pub02'],
    ['/tokushoho', '/public/s_pub03'],
    ['/data-deletion', '/public/s_pub04'],
  ];

  it.each(AFFECTED)('%s と %s で AppShell の有無が一致する', (clean, internal) => {
    const a = renderAt(clean);
    const cleanHasShell = hasAppShell(a.container);
    a.unmount();

    const b = renderAt(internal);
    expect(hasAppShell(b.container)).toBe(cleanHasShell);
  });
});

describe('AppShell が付く画面は従来どおり (T-UC-46 tier_3)', () => {
  it.each([
    ['/projects', '/projects/s_b01'],
    ['/tasks', '/tasks/s_i01'],
    ['/chat', '/chat/s_e01'],
  ])('%s は AppShell 付きのまま (内部ルート %s でも同じ)', (clean, internal) => {
    const a = renderAt(clean);
    expect(hasAppShell(a.container)).toBe(true);
    a.unmount();

    const b = renderAt(internal);
    expect(hasAppShell(b.container)).toBe(true);
  });
});
