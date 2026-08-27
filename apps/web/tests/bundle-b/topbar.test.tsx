/**
 * T-US-01 / F-VIS: TopBar tests (モック topbar 忠実化後の契約)
 *
 * ワークスペースピッカーは Rule 10 準拠:
 *   - workspaces + onSelectWorkspace 配線時のみ button (実 dropdown)
 *   - 未配線時は非インタラクティブ表示 (死にボタンを置かない)
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TopBar } from '../../components/layout/TopBar';

const WORKSPACES = [
  { id: 'w1', name: 'ENGINE BASE' },
  { id: 'w2', name: 'Second WS' },
] as const;

describe('TopBar', () => {
  it('renders the workspace name as non-interactive when no switch handler is wired', () => {
    render(<TopBar workspaceName="ENGINE BASE" />);
    expect(screen.getByText('ENGINE BASE')).toBeInTheDocument();
    // 死にボタン禁止: ハンドラ未配線ならクリック可能な button を出さない
    expect(
      screen.queryByRole('button', { name: /ワークスペース: ENGINE BASE/ }),
    ).not.toBeInTheDocument();
  });

  it('opens a real workspace listbox and fires onSelectWorkspace', () => {
    const onSelect = vi.fn();
    render(
      <TopBar
        workspaceName="ENGINE BASE"
        workspaces={WORKSPACES}
        currentWorkspaceId="w1"
        onSelectWorkspace={onSelect}
      />,
    );
    const pill = screen.getByRole('button', {
      name: /ワークスペース: ENGINE BASE/,
    });
    expect(pill).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(pill);
    expect(pill).toHaveAttribute('aria-expanded', 'true');
    const listbox = screen.getByRole('listbox', {
      name: 'ワークスペースを選択',
    });
    expect(listbox).toBeInTheDocument();
    // 現在 WS には aria-selected が付く
    expect(
      screen.getByRole('option', { name: /ENGINE BASE/ }),
    ).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('option', { name: /Second WS/ }));
    expect(onSelect).toHaveBeenCalledWith('w2');
    // 選択後は閉じる
    expect(
      screen.queryByRole('listbox', { name: 'ワークスペースを選択' }),
    ).not.toBeInTheDocument();
  });

  it('closes the workspace listbox on Escape', () => {
    render(
      <TopBar
        workspaceName="ENGINE BASE"
        workspaces={WORKSPACES}
        currentWorkspaceId="w1"
        onSelectWorkspace={() => {}}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /ワークスペース: ENGINE BASE/ }),
    );
    expect(
      screen.getByRole('listbox', { name: 'ワークスペースを選択' }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('listbox', { name: 'ワークスペースを選択' }),
    ).not.toBeInTheDocument();
  });

  it('renders the breadcrumb label', () => {
    render(<TopBar workspaceName="ENGINE BASE" breadcrumb="プロジェクト" />);
    expect(screen.getByText('プロジェクト')).toBeInTheDocument();
  });

  it('renders the trailing slot', () => {
    render(<TopBar trailing={<span>RIGHT</span>} />);
    expect(screen.getByText('RIGHT')).toBeInTheDocument();
  });

  it('has banner landmark role', () => {
    render(<TopBar />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });

  it('renders the project context pill when projectName is set (GAP-117)', () => {
    render(<TopBar workspaceName="WS-A" projectName="プロジェクトX" />);
    expect(screen.getByLabelText('プロジェクト: プロジェクトX')).toHaveTextContent(
      'プロジェクトX',
    );
  });

  it('renders no project pill without projectName (GAP-117)', () => {
    render(<TopBar workspaceName="WS-A" />);
    expect(screen.queryByLabelText(/プロジェクト:/)).not.toBeInTheDocument();
  });
});

describe('TopBar 320px 横スクロール対策 (GAP-236)', () => {
  it('ワークスペース名ラベルは最小幅で畳むクラスを持ち、名前は aria-label で残る', () => {
    render(<TopBar workspaceName="通し検証ワークスペース" />);
    // 視覚ラベルは最小幅では非表示 (min-[400px]:inline で復帰) — 幅を回収する
    const label = screen.getByText('通し検証ワークスペース');
    expect(label.className).toContain('hidden');
    expect(label.className).toContain('min-[400px]:inline');
    // 名前自体は aria-label に残り、支援技術からは常に読める
    expect(
      screen.getByLabelText('ワークスペース: 通し検証ワークスペース'),
    ).toBeInTheDocument();
  });

  it('パンくずは最小幅で畳むクラスを持つ', () => {
    render(<TopBar workspaceName="WS" breadcrumb="取り込み" />);
    const crumb = screen.getByText('取り込み').closest('div');
    expect(crumb?.className).toContain('hidden');
    expect(crumb?.className).toContain('min-[400px]:flex');
  });
});
