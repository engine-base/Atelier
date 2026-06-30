/**
 * S-J01 承認待ち (5 種統合) — T-UC-17
 *
 * - 5 種別 (task / output / publish / refund / access) の承認を統合表示
 * - 承認 / 却下 アクションは onAction prop で外部に委譲
 */

"use client";

import * as React from "react";

import {
  DataTable,
  type ColumnDef,
} from "../../../../components/data-table/DataTable";

export type ApprovalKind = "task" | "output" | "publish" | "refund" | "access";

export interface ApprovalRow {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly requester: string;
  readonly created_at: string;
}

const KIND_LABEL: Record<ApprovalKind, string> = {
  task: "タスク",
  output: "成果物",
  publish: "公開",
  refund: "返金",
  access: "アクセス",
};

export interface ApprovalsListProps {
  readonly rows: readonly ApprovalRow[];
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
}

export function ApprovalsList({
  rows,
  onApprove,
  onReject,
}: ApprovalsListProps) {
  const cols: ColumnDef<ApprovalRow>[] = [
    { id: "kind", header: "種別", cell: (r) => KIND_LABEL[r.kind] },
    { id: "title", header: "内容", cell: (r) => r.title },
    { id: "requester", header: "依頼者", cell: (r) => r.requester },
    {
      id: "created",
      header: "日時",
      cell: (r) => r.created_at,
      align: "right",
    },
    {
      id: "actions",
      header: "アクション",
      cell: (r) => (
        <div className="flex gap-xs">
          <button
            type="button"
            onClick={() => onApprove(r.id)}
            aria-label={`${r.title} を承認`}
            className="inline-flex h-8 items-center rounded-sm bg-tertiary px-sm text-label-md text-tertiary-fg"
          >
            承認
          </button>
          <button
            type="button"
            onClick={() => onReject(r.id)}
            aria-label={`${r.title} を却下`}
            className="inline-flex h-8 items-center rounded-sm border border-error px-sm text-label-md text-error"
          >
            却下
          </button>
        </div>
      ),
      align: "right",
    },
  ];

  return (
    <DataTable
      caption="承認待ち一覧"
      columns={cols}
      rows={rows}
      rowKey={(r) => r.id}
      emptyMessage="承認待ち項目はありません"
    />
  );
}
