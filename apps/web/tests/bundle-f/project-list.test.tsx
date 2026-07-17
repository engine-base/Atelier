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
    expect(screen.getByText('Beta')).toBeInTheDocument();
    // 種別バッジ
    expect(screen.getByText('クライアント案件')).toBeInTheDocument();
    expect(screen.getByText('自社プロダクト')).toBeInTheDocument();
    // 工程 pill (current_phase 由来)
    expect(screen.getByText('実装中')).toBeInTheDocument();
    expect(screen.getByText('納品済')).toBeInTheDocument();
  });

  it('renders — for null client_name', () => {
    render(<ProjectList {...baseProps} />);
    expect(screen.getByText('—')).toBeInTheDocument();
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
