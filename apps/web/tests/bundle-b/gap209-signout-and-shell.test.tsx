/**
 * GAP-209 — 「押したのに帰れない」「入れるのに出られない」をなくす
 *
 * ① `/t-uc-36`〜`/t-uc-40`（通知センター・プロフィール・WS 切替・PJ 切替・検索）は
 *    シェルを持たず、押して飛んだ先に **ナビも戻る導線も無かった**。
 *    ブラウザの戻るでしか帰れない = 行き止まり。
 * ② サインアウトの導線が **アプリ本体に存在しなかった**（出られるのは
 *    クライアントポータルだけ）。共有 PC で前の人のまま使えてしまう。
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/projects' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const api = vi.hoisted(() => ({ getJson: vi.fn(), signOut: vi.fn() }));
vi.mock('../../lib/auth/connector', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, getJson: api.getJson, signOut: api.signOut };
});

import { ConditionalAppShell } from '../../components/layout/ConditionalAppShell';
import { UserMenu } from '../../components/layout/UserMenu';
import { CURRENT_WS_KEY } from '../../lib/currentWorkspace';

beforeEach(() => {
  window.localStorage.setItem(CURRENT_WS_KEY, 'w1');
  api.getJson.mockImplementation(async (path: string) => {
    if (path === '/workspaces') return { data: [{ id: 'w1', name: 'WS-A' }] };
    if (path === '/me') return { data: { display_name: '田中' } };
    if (path.startsWith('/approval-inbox')) return { data: [] };
    return { data: null };
  });
  api.signOut.mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('GAP-209 行き止まりの画面にシェルを付ける', () => {
  it.each([
    ['/t-uc-36', '通知センター'],
    ['/t-uc-37', 'プロフィール'],
    ['/t-uc-38', 'ワークスペース切替'],
    ['/t-uc-39', 'プロジェクト切替'],
    ['/t-uc-40', '検索'],
  ])('%s (%s) にはナビが出る = 帰れる', async (path) => {
    nav.pathname = path;
    render(
      <ConditionalAppShell>
        <p>PAGE</p>
      </ConditionalAppShell>,
    );
    expect(await screen.findByRole('link', { name: 'プロジェクト' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('初回ログインのウォークスルー (/t-uc-35) は今までどおりシェルを付けない', () => {
    nav.pathname = '/t-uc-35';
    render(
      <ConditionalAppShell>
        <p>WALKTHROUGH</p>
      </ConditionalAppShell>,
    );
    expect(screen.getByText('WALKTHROUGH')).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });

  it('法務ページ (/terms) は今までどおり bare', () => {
    nav.pathname = '/terms';
    render(
      <ConditionalAppShell>
        <p>TERMS</p>
      </ConditionalAppShell>,
    );
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });
});

describe('GAP-209 サインアウトの導線', () => {
  it('アバターを押すとメニューが開き、**サインアウト**がある', async () => {
    nav.pathname = '/projects';
    render(
      <ConditionalAppShell>
        <p>PAGE</p>
      </ConditionalAppShell>,
    );
    const avatar = await screen.findByRole('button', { name: /アカウント: 田中/ });
    fireEvent.click(avatar);
    expect(screen.getByRole('menu', { name: 'アカウントメニュー' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /サインアウト/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /プロフィール/ })).toHaveAttribute(
      'href',
      '/t-uc-37',
    );
  });

  it('押すと **サーバー側の失効まで**呼んでからサインイン画面へ送る', async () => {
    const onSignedOut = vi.fn();
    render(<UserMenu label="田中" onSignedOut={onSignedOut} />);
    fireEvent.click(screen.getByRole('button', { name: /アカウント: 田中/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /サインアウト/ }));
    await waitFor(() => expect(api.signOut).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });

  it('サーバーに繋がらなくても **出られる** (手元は片付けて画面は進む)', async () => {
    api.signOut.mockResolvedValue(false); // 失効は出来なかった
    const onSignedOut = vi.fn();
    render(<UserMenu label="田中" onSignedOut={onSignedOut} />);
    fireEvent.click(screen.getByRole('button', { name: /アカウント: 田中/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /サインアウト/ }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });

  it('Escape でメニューを閉じられる', async () => {
    render(<UserMenu label="田中" onSignedOut={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /アカウント: 田中/ }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
