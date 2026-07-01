/**
 * S-B01 プロジェクト一覧 — T-UC-03 (client component)
 *
 * DataTable (Bundle C) で project を表示。loading / error / empty 状態対応。
 * 各行クリックで onSelect(id) を発火（親が /projects/s_b02?project=id へ遷移）。
 */

"use client";

import * as React from "react";

import {
  DataTable,
  type ColumnDef,
} from "../../../../components/data-table/DataTable";
import { Pagination } from "../../../../components/data-table/Pagination";
import { formatDate } from "../../../../lib/i18n";

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly client_name: string | null;
  readonly lifecycle: "active" | "archived" | "paused";
  readonly created_at: string;
}

export interface ProjectListProps {
  readonly rows: readonly ProjectRow[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly prevCursor: string | null;
  readonly nextCursor: string | null;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onSelect?: (id: string) => void;
}

const LIFECYCLE_LABEL: Record<ProjectRow["lifecycle"], string> = {
  active: "進行中",
  paused: "一時停止",
  archived: "アーカイブ",
};

export function ProjectList({
  rows,
  loading,
  error,
  prevCursor,
  nextCursor,
  onPrev,
  onNext,
  onSelect,
}: ProjectListProps) {
  const cols: ColumnDef<ProjectRow>[] = [
    {
      id: "name",
      header: "プロジェクト名",
      cell: (r) =>
        onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(r.id)}
            className="text-primary hover:underline"
          >
            {r.name}
          </button>
        ) : (
          r.name
        ),
    },
    { id: "client", header: "クライアント", cell: (r) => r.client_name ?? "—" },
    {
      id: "lifecycle",
      header: "状態",
      cell: (r) => LIFECYCLE_LABEL[r.lifecycle],
    },
    {
      id: "created",
      header: "作成日",
      cell: (r) => formatDate(r.created_at, "short-date"),
      align: "right",
    },
  ];

  return (
    <div className="flex flex-col gap-md">
      <DataTable
        caption="プロジェクト一覧"
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        emptyMessage="プロジェクトがありません"
      />
      <Pagination
        prevCursor={prevCursor}
        nextCursor={nextCursor}
        onPrev={onPrev}
        onNext={onNext}
        summary={rows.length > 0 ? `${rows.length} 件表示中` : undefined}
      />
    </div>
  );
}
