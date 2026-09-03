/**
 * T-UC-03 ProjectList tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectList, type ProjectRow } from '../../app/projects/s_b01/_components/ProjectList';

const ROWS: ProjectRow[] = [
  {
    id: 'p1',
    name: 'Alpha',
    client_name: 'ACME',
    type: 'client_project',
    lifecycle: 'active',
    currentPhase: 'implementation',
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-02T00:00:00Z',
  },
  {
    id: 'p2',
    name: 'Beta',
    client_name: null,
    type: 'self_product',
    lifecycle: 'archived',
    currentPhase: 'delivery',
    created_at: '2026-04-15T00:00:00Z',
    updated_at: '2026-04-16T00:00:00Z',
  },
];

describe('ProjectList (T-UC-03)', () => {
  const baseProps = {
    rows: ROWS,
    prevCursor: null as string | null,
    nextCursor: null as string | null,
    onPrev: () => undefined,
    onNext: () => undefined,
  };

  it('renders project cards with name / type badge / phase pill', () => {
    render(<ProjectList {...baseProps} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    // GAP-277 (通し J38-06): 「すべて」= アクティブ一覧。アーカイブ済みはタブで出す
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
    expect(screen.getByText('クライアント案件')).toBeInTheDocument();
    expect(screen.getByText('実装中')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'アーカイブ' }));
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('自社プロダクト')).toBeInTheDocument();
    expect(screen.getByText('納品済')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  it('renders — for null client_name', () => {
    render(<ProjectList {...baseProps} />);
    fireEvent.click(screen.getByRole('tab', { name: 'アーカイブ' }));
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('GAP-277: archive / unarchive / restore actions and the deleted tab', () => {
    const onArchive = vi.fn();
    const onUnarchive = vi.fn();
    const onRestore = vi.fn();
    const deletedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const rows: ProjectRow[] = [
      ...ROWS,
      {
        id: 'p3',
        name: 'Gamma',
        client_name: null,
        type: 'personal',
        lifecycle: 'deleted',
        currentPhase: 'hearing',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        deleted_at: deletedAt,
      },
    ];
    render(
      <ProjectList
        {...baseProps}
        rows={rows}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
        onRestore={onRestore}
      />,
    );
    // アクティブ → アーカイブ
    fireEvent.click(screen.getByRole('button', { name: 'Alpha をアーカイブ' }));
    expect(onArchive).toHaveBeenCalledWith('p1');
    // アーカイブ → 戻す
    fireEvent.click(screen.getByRole('tab', { name: 'アーカイブ' }));
    fireEvent.click(screen.getByRole('button', { name: 'Beta をアクティブに戻す' }));
    expect(onUnarchive).toHaveBeenCalledWith('p2');
    // 削除済み → 残り日数 + 復元
    fireEvent.click(screen.getByRole('tab', { name: '削除済み' }));
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(screen.getByText(/25 日後に完全に削除/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Gamma を復元する（残り 25 日）/ }));
    expect(onRestore).toHaveBeenCalledWith('p3');
  });

  it('invokes onSelect with project id when name button clicked', () => {
    const onSelect = vi.fn();
    render(<ProjectList {...baseProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('Alpha'));
    expect(onSelect).toHaveBeenCalledWith('p1');
  });

  it('shows empty message when rows is empty', () => {
    render(<ProjectList {...baseProps} rows={[]} />);
    expect(screen.getByText('プロジェクトがありません')).toBeInTheDocument();
  });

  it('renders summary in Pagination', () => {
    render(<ProjectList {...baseProps} />);
    expect(screen.getByText(/2 件のプロジェクト/)).toBeInTheDocument();
  });
});
