/**
 * GAP-117: ConditionalAppShell の文脈分離テスト (経営者指示の IA 変更)
 *
 *   - プロジェクト系画面: プロジェクト nav のみ + 「← ワークスペース全体へ」導線 +
 *     TopBar にプロジェクト名ピル
 *   - WS 系画面: WS nav のみ (プロジェクトを覚えていても混ぜない)
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/projects' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
}));

const api = vi.hoisted(() => ({
  getJson: vi.fn(),
}));

vi.mock('../../lib/auth/connector', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, getJson: api.getJson };
});

import { ConditionalAppShell } from '../../components/layout/ConditionalAppShell';
import { CURRENT_PROJECT_KEY } from '../../lib/useProjectId';

function mockApi() {
  api.getJson.mockImplementation(async (path: string) => {
    if (path === '/workspaces') return { data: [{ id: 'w1', name: 'WS-A' }] };
    if (path === '/me') return { data: { display_name: 'U' } };
    if (path.startsWith('/approval-inbox')) return { data: [] };
    if (path === '/projects/p1') return { data: { id: 'p1', name: 'プロジェクトX' } };
    return { data: null };
  });
}

beforeEach(() => {
  mockApi();
  window.localStorage.setItem(CURRENT_PROJECT_KEY, 'p1');
});

afterEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe('ConditionalAppShell (GAP-117 文脈分離)', () => {
  it('プロジェクト系画面ではプロジェクト nav のみ + WS へ戻る導線 + TopBar ピル', async () => {
    nav.pathname = '/tasks';
    render(
      <ConditionalAppShell>
        <p>PAGE</p>
      </ConditionalAppShell>,
    );
    // プロジェクト名解決後: プロジェクトセクション + 戻る導線
    expect(
      await screen.findByRole('link', { name: '← ワークスペース全体へ' }),
    ).toHaveAttribute('href', '/projects');
    expect(screen.getByText(/プロジェクト · プロジェクトX/)).toBeInTheDocument();
    // WS nav (AI社員 等) は混ぜない
    expect(screen.queryByRole('link', { name: 'AI社員' })).not.toBeInTheDocument();
    // TopBar のプロジェクトピル
    expect(screen.getByLabelText('プロジェクト: プロジェクトX')).toBeInTheDocument();
  });

  it('WS 系画面ではプロジェクトを覚えていても WS nav のみ', async () => {
    nav.pathname = '/projects';
    render(
      <ConditionalAppShell>
        <p>PAGE</p>
      </ConditionalAppShell>,
    );
    expect(await screen.findByRole('link', { name: 'AI社員' })).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole('link', { name: '← ワークスペース全体へ' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/プロジェクト · プロジェクトX/)).not.toBeInTheDocument();
    });
  });

  it('bare 画面 (利用規約等) ではシェルを付けない', () => {
    nav.pathname = '/terms';
    render(
      <ConditionalAppShell>
        <p>BARE-PAGE</p>
      </ConditionalAppShell>,
    );
    expect(screen.getByText('BARE-PAGE')).toBeInTheDocument();
    expect(screen.queryByRole('banner')).not.toBeInTheDocument();
  });
});
