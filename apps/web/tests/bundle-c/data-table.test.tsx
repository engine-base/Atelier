/**
 * T-US-10 DataTable + Pagination tests
 */

// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type ColumnDef, DataTable } from '../../components/data-table/DataTable';
import { Pagination } from '../../components/data-table/Pagination';

interface Row {
  readonly id: string;
  readonly name: string;
  readonly count: number;
}

const cols: ColumnDef<Row>[] = [
  { id: 'name', header: '名前', cell: (r) => r.name },
  { id: 'count', header: '件数', cell: (r) => String(r.count), align: 'right' },
];

describe('DataTable (T-US-10)', () => {
  it('renders rows and column headers', () => {
    render(
      <DataTable
        caption="t"
        columns={cols}
        rows={[
          { id: 'a', name: 'A', count: 1 },
          { id: 'b', name: 'B', count: 2 },
        ]}
        rowKey={(r) => r.id}
      />,
    );
    expect(screen.getByText('名前')).toBeInTheDocument();
    expect(screen.getByText('件数')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    render(<DataTable caption="t" columns={cols} rows={[]} rowKey={(r) => r.id} loading />);
    expect(screen.getByText(/読み込み中/)).toBeInTheDocument();
  });

  it('shows error state', () => {
    render(
      <DataTable caption="t" columns={cols} rows={[]} rowKey={(r) => r.id} error="ng" />,
    );
    expect(screen.getByText('ng')).toBeInTheDocument();
  });

  it('shows empty message when no rows', () => {
    render(
      <DataTable
        caption="t"
        columns={cols}
        rows={[]}
        rowKey={(r) => r.id}
        emptyMessage="empty!"
      />,
    );
    expect(screen.getByText('empty!')).toBeInTheDocument();
  });

  it('caption is sr-only present', () => {
    const { container } = render(
      <DataTable
        caption="hidden-caption"
        columns={cols}
        rows={[{ id: 'a', name: 'A', count: 1 }]}
        rowKey={(r) => r.id}
      />,
    );
    const caption = container.querySelector('caption');
    expect(caption?.textContent).toBe('hidden-caption');
    expect(caption?.className).toContain('sr-only');
  });
});

describe('Pagination (T-US-10)', () => {
  it('disables prev when prevCursor is null', () => {
    const { container } = render(
      <Pagination
        prevCursor={null}
        nextCursor="n1"
        onPrev={() => undefined}
        onNext={() => undefined}
      />,
    );
    const buttons = container.querySelectorAll('button');
    expect((buttons[0]! as HTMLButtonElement).disabled).toBe(true);
    expect(buttons[0]!.getAttribute('aria-disabled')).toBe('true');
  });

  it('disables next when nextCursor is null', () => {
    const { container } = render(
      <Pagination
        prevCursor="p1"
        nextCursor={null}
        onPrev={() => undefined}
        onNext={() => undefined}
      />,
    );
    const buttons = container.querySelectorAll('button');
    expect((buttons[1]! as HTMLButtonElement).disabled).toBe(true);
  });

  it('invokes onPrev / onNext callbacks', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(<Pagination prevCursor="p" nextCursor="n" onPrev={onPrev} onNext={onNext} />);
    fireEvent.click(screen.getByText('戻る'));
    fireEvent.click(screen.getByText('次へ'));
    expect(onPrev).toHaveBeenCalled();
    expect(onNext).toHaveBeenCalled();
  });

  it('renders summary text', () => {
    render(
      <Pagination
        prevCursor={null}
        nextCursor={null}
        summary="12 / 320"
        onPrev={() => undefined}
        onNext={() => undefined}
      />,
    );
    expect(screen.getByText('12 / 320')).toBeInTheDocument();
  });
});
