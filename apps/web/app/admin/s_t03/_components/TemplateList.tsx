/**
 * S-T03 AI 社員テンプレ — T-UC-32
 *
 * AI 社員のテンプレ (role, system_prompt 雛形) 一覧。複製/編集/削除。
 */

"use client";

import * as React from "react";

import {
  DataTable,
  type ColumnDef,
} from "../../../../components/data-table/DataTable";

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly description: string;
}

export interface TemplateListProps {
  readonly templates: readonly Template[];
  /** 複製/編集/削除。いずれも未指定なら「アクション」列を出さない（read-only 時など）。 */
  readonly onClone?: (id: string) => void;
  readonly onEdit?: (id: string) => void;
  readonly onDelete?: (id: string) => void;
}

export function TemplateList({
  templates,
  onClone,
  onEdit,
  onDelete,
}: TemplateListProps) {
  const hasActions = Boolean(onClone || onEdit || onDelete);
  const cols: ColumnDef<Template>[] = [
    { id: "name", header: "名前", cell: (r) => r.name },
    { id: "role", header: "役割", cell: (r) => r.role },
    { id: "desc", header: "説明", cell: (r) => r.description },
    ...(hasActions
      ? [
          {
            id: "actions",
            header: "アクション",
            cell: (r: Template) => (
              <div className="flex gap-xs">
                {onClone ? (
                  <button
                    type="button"
                    onClick={() => onClone(r.id)}
                    aria-label={`${r.name} を複製`}
                    className="inline-flex h-8 items-center rounded-sm border border-surface-variant/40 px-sm text-label-md text-surface"
                  >
                    複製
                  </button>
                ) : null}
                {onEdit ? (
                  <button
                    type="button"
                    onClick={() => onEdit(r.id)}
                    aria-label={`${r.name} を編集`}
                    className="inline-flex h-8 items-center rounded-sm bg-primary px-sm text-label-md text-primary-fg"
                  >
                    編集
                  </button>
                ) : null}
                {onDelete ? (
                  <button
                    type="button"
                    onClick={() => onDelete(r.id)}
                    aria-label={`${r.name} を削除`}
                    className="inline-flex h-8 items-center rounded-sm border border-error px-sm text-label-md text-error"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ),
            align: "right" as const,
          },
        ]
      : []),
  ];
  return (
    <DataTable
      caption="AI 社員テンプレ一覧"
      columns={cols}
      rows={templates}
      rowKey={(r) => r.id}
      emptyMessage="テンプレがありません"
    />
  );
}
