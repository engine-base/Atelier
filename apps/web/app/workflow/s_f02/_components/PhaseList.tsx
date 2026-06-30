/**
 * S-F02 フェーズ管理 — T-UC-11
 *
 * - フェーズの一覧/順序変更/状態変更
 * - DataTable で簡易表示、状態変更は select で
 */

"use client";

import * as React from "react";

import {
  DataTable,
  type ColumnDef,
} from "../../../../components/data-table/DataTable";

export type PhaseStatus = "pending" | "in_progress" | "done" | "blocked";

export interface PhaseRow {
  readonly id: string;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly order: number;
}

export interface PhaseListProps {
  readonly rows: readonly PhaseRow[];
  /** 状態遷移。controlled（コンテナが API 配線して rows を更新する）。 */
  readonly onTransition?: (id: string, status: PhaseStatus) => void;
}

const STATUS_LABEL: Record<PhaseStatus, string> = {
  pending: "未着手",
  in_progress: "進行中",
  done: "完了",
  blocked: "ブロック",
};

export function PhaseList({ rows, onTransition }: PhaseListProps) {
  const update = (id: string, status: PhaseStatus) =>
    onTransition?.(id, status);

  const cols: ColumnDef<PhaseRow>[] = [
    { id: "order", header: "#", cell: (r) => String(r.order), align: "right" },
    { id: "name", header: "フェーズ", cell: (r) => r.name },
    {
      id: "status",
      header: "状態",
      cell: (r) => (
        <select
          value={r.status}
          onChange={(e) => update(r.id, e.target.value as PhaseStatus)}
          aria-label={`${r.name} の状態`}
          className="h-8 rounded-md border border-surface-variant bg-surface px-sm text-label-md text-on-surface"
        >
          {(Object.keys(STATUS_LABEL) as PhaseStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      ),
    },
  ];

  return (
    <DataTable
      caption="フェーズ一覧"
      columns={cols}
      rows={rows}
      rowKey={(r) => r.id}
      emptyMessage="フェーズがありません"
    />
  );
}
