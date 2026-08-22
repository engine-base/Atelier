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
import { CURRENT_WS_KEY } from '../../lib/currentWorkspace';

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

/**
 * GAP-207 — 経営者指摘「オンボーディングやその他でサイドバーいらないときは
 * 表示させなくていいよね？ その時押されても困るしUX悪いし」
 *
 * ワークスペースがまだ 1 つも無い間、サイドバーの 6 本 (プロジェクト /
 * AI社員 / ナレッジ / テンプレート / 承認待ち / WS設定) は **どれも空か
 * 作れない画面**へのリンクだった。押しても何も起きないものを出さない。
 */
describe('GAP-207 ワークスペースが無い間はサイドバーを出さない', () => {
  function mockNoWorkspace(): void {
    api.getJson.mockImplementation(async (path: string) => {
      if (path === '/workspaces') return { data: [] };
      if (path === '/me') return { data: { display_name: 'U' } };
      if (path.startsWith('/approval-inbox')) return { data: [] };
      return { data: null };
    });
  }

  it('ワークスペースが 0 件なら、押しても何もできない nav を出さない', async () => {
    nav.pathname = '/projects';
    mockNoWorkspace();
    render(
      <ConditionalAppShell>
        <p>ONBOARDING</p>
      </ConditionalAppShell>,
    );
    await waitFor(() => expect(api.getJson).toHaveBeenCalled());
    // 本文 (ワークスペース作成フォーム) は出る
    expect(screen.getByText('ONBOARDING')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'AI社員' })).not.toBeInTheDocument();
    });
    for (const label of ['プロジェクト', 'ナレッジ', 'テンプレート', '承認待ち', 'WS設定']) {
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
    // 中身の無いワークスペースピルも出さない (何も指していないため)
    expect(screen.queryByLabelText(/^ワークスペース: /)).not.toBeInTheDocument();
    // 探すものも承認するものもまだ無い → 検索・通知も出さない
    expect(screen.queryByRole('link', { name: '検索' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /通知センター/ })).not.toBeInTheDocument();
    // ヘッダーが空にならないようロゴは残す
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('ワークスペースが 1 件でもあれば、従来どおり出す', async () => {
    nav.pathname = '/projects';
    render(
      <ConditionalAppShell>
        <p>PAGE</p>
      </ConditionalAppShell>,
    );
    expect(await screen.findByRole('link', { name: 'AI社員' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^ワークスペース: /)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '検索' })).toBeInTheDocument();
  });

  it('前回のワークスペースを覚えていれば、**取得を待たずに**出す (ちらつかない)', () => {
    nav.pathname = '/projects';
    // /workspaces が返ってこない状態を作る (読み込み中)
    api.getJson.mockImplementation(() => new Promise(() => {}));
    window.localStorage.setItem(CURRENT_WS_KEY, 'w1');
    render(
      <ConditionalAppShell>
        <p>PAGE</p>
      </ConditionalAppShell>,
    );
    // 取得完了を待たずに nav がある = 既存ユーザーの画面が一瞬消えない
    expect(screen.getByRole('link', { name: 'AI社員' })).toBeInTheDocument();
  });

  it('覚えていない (新規登録直後) なら、取得が終わるまで出さない', () => {
    nav.pathname = '/projects';
    api.getJson.mockImplementation(() => new Promise(() => {}));
    render(
      <ConditionalAppShell>
        <p>PAGE</p>
      </ConditionalAppShell>,
    );
    // 出してから消す (ちらつき) をしない
    expect(screen.queryByRole('link', { name: 'AI社員' })).not.toBeInTheDocument();
  });
});
