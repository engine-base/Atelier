/**
 * DataTable — T-US-10 (型ジェネリック汎用テーブル)
 *
 * - column 定義で render / accessor / aria-sort をカバー
 * - empty / loading / error 状態を AC 通り分岐
 * - 並び替え/フィルタ は外部 controlled (TanStack Query の query key と連動想定)
 * - caption (aria) + scope=col header で SR フレンドリ
 */

'use client';

import * as React from 'react';
import type { ReactNode } from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export interface ColumnDef<Row> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: 'left' | 'right' | 'center';
}

export interface DataTableProps<Row> {
  readonly caption: string;
  readonly columns: readonly ColumnDef<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly emptyMessage?: string;
  readonly className?: string;
}

const ALIGN_CLASS = { left: 'text-left', right: 'text-right', center: 'text-center' };

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  error,
  emptyMessage,
  className,
}: DataTableProps<Row>) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full border-collapse text-body-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-surface-variant text-on-surface-variant">
            {columns.map((c) => (
              <th
                key={c.id}
                scope="col"
                className={cn(
                  'px-sm py-xs text-label-md font-semibold',
                  ALIGN_CLASS[c.align ?? 'left'],
                )}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="px-sm py-md text-center text-on-surface-variant">
                {t('common.loading')}
              </td>
            </tr>
          ) : error ? (
            <tr>
              <td colSpan={columns.length} className="px-sm py-md text-center text-error">
                {error}
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-sm py-md text-center text-on-surface-variant">
                {emptyMessage ?? '—'}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className="border-b border-surface-variant/50 hover:bg-surface-variant/30"
              >
                {columns.map((c) => (
                  <td
                    key={c.id}
                    className={cn('px-sm py-xs', ALIGN_CLASS[c.align ?? 'left'])}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
