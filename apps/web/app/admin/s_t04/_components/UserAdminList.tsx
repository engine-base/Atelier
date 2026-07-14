/**
 * S-T04 ユーザー管理 — T-UC-33
 *
 * 全 user 一覧。状態 (active/suspended/deleted) + last_login 表示、suspend/復元 action。
 */

"use client";

import * as React from "react";

import {
  DataTable,
  type ColumnDef,
} from "../../../../components/data-table/DataTable";

export type UserState = "active" | "suspended" | "deleted";

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly state: UserState;
  readonly last_login: string | null;
}

const STATE_LABEL: Record<UserState, string> = {
  active: "有効",
  suspended: "停止中",
  deleted: "削除済",
};

export interface UserAdminListProps {
  readonly users: readonly AdminUser[];
  /** 停止/復元。いずれも未指定なら「アクション」列を出さない（read-only 時など）。 */
  readonly onSuspend?: (id: string) => void;
  readonly onRestore?: (id: string) => void;
}

export function UserAdminList({
  users,
  onSuspend,
  onRestore,
}: UserAdminListProps) {
  const hasActions = Boolean(onSuspend || onRestore);
  const cols: ColumnDef<AdminUser>[] = [
    { id: "email", header: "メール", cell: (r) => r.email },
    { id: "state", header: "状態", cell: (r) => STATE_LABEL[r.state] },
    {
      id: "last_login",
      header: "最終ログイン",
      cell: (r) => r.last_login ?? "—",
    },
    ...(hasActions
      ? [
          {
            id: "actions",
            header: "アクション",
            cell: (r: AdminUser) =>
              onSuspend && r.state === "active" ? (
                <button
                  type="button"
                  onClick={() => onSuspend(r.id)}
                  aria-label={`${r.email} を停止`}
                  className="inline-flex h-8 items-center rounded-sm border border-error px-sm text-label-md text-error"
                >
                  停止
                </button>
              ) : onRestore && r.state === "suspended" ? (
                <button
                  type="button"
                  onClick={() => onRestore(r.id)}
                  aria-label={`${r.email} を復元`}
                  className="inline-flex h-8 items-center rounded-sm bg-tertiary-container px-sm text-label-md font-semibold text-tertiary-container-fg"
                >
                  復元
                </button>
              ) : (
                <span className="text-label-md text-surface-variant">—</span>
              ),
            align: "right" as const,
          },
        ]
      : []),
  ];
  return (
    <DataTable
      caption="ユーザー一覧"
      columns={cols}
      rows={users}
      rowKey={(r) => r.id}
      emptyMessage="ユーザーがいません"
    />
  );
}
