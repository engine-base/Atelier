/**
 * S-T05 監査ログ — T-UC-34
 *
 * audit_logs (E-020) を表示。action / actor_type+actor_id / target / ip / created_at。
 * フィルタ: action prefix, actor_type、日付範囲(範囲 picker は将来)。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { DataTable, type ColumnDef } from '../../../../components/data-table/DataTable';

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly actor_type: 'user' | 'ai' | 'system' | 'anonymous';
  readonly actor_id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly ip_address: string | null;
  readonly created_at: string;
}

export interface AuditLogTableProps {
  readonly entries: readonly AuditEntry[];
}

export function AuditLogTable({ entries }: AuditLogTableProps) {
  const [query, setQuery] = useState('');
  const filtered = entries.filter(
    (e) => query === '' || e.action.includes(query) || e.actor_id.includes(query),
  );

  const cols: ColumnDef<AuditEntry>[] = [
    { id: 'created', header: '日時', cell: (r) => r.created_at },
    { id: 'action', header: 'action', cell: (r) => <code>{r.action}</code> },
    { id: 'actor', header: 'actor', cell: (r) => `${r.actor_type}:${r.actor_id}` },
    { id: 'target', header: 'target', cell: (r) => `${r.target_type}:${r.target_id}` },
    { id: 'ip', header: 'IP', cell: (r) => r.ip_address ?? '—' },
  ];

  return (
    <section className="flex flex-col gap-md">
      <label className="flex flex-col gap-xs">
        <span className="sr-only">action / actor 検索</span>
        <input
          type="search"
          placeholder="action / actor で絞り込み"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 w-full max-w-sm rounded-md border border-surface-variant/40 bg-surface/10 px-sm text-body-md text-surface"
        />
      </label>
      <DataTable
        caption="監査ログ"
        columns={cols}
        rows={filtered}
        rowKey={(r) => r.id}
        emptyMessage="監査ログがありません"
      />
    </section>
  );
}
