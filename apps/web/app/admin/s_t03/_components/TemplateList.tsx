/**
 * S-T03 AI 社員テンプレ — T-UC-32
 *
 * AI 社員のテンプレ (role, system_prompt 雛形) 一覧。複製/編集/削除。
 * モック admin/S-T03-templates.html の左「テンプレ一覧ペイン」(tpl-list-pane) を
 * カードリストとして忠実再現する。
 */

"use client";

import * as React from "react";

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly description: string;
}

export interface TemplateListProps {
  readonly templates: readonly Template[];
  /** 複製/編集/削除。いずれも未指定なら「アクション」を出さない（read-only 時など）。 */
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

  return (
    <section
      aria-label="AI 社員テンプレ一覧"
      className="overflow-hidden rounded-lg border border-border bg-white"
    >
      <header className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            Default Templates
          </p>
          <strong className="text-sm font-bold text-on-surface">
            {templates.length} 名のテンプレ
          </strong>
        </div>
      </header>

      {templates.length === 0 ? (
        <p className="py-12 text-center text-body-md text-on-surface-variant">
          テンプレがありません
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {templates.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-variant"
            >
              <span
                aria-hidden="true"
                className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary-container text-lg font-bold text-on-primary-container"
              >
                {t.name.charAt(0)}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-on-surface">
                  {t.name}
                </p>
                {t.description ? (
                  <p className="truncate text-[11px] text-on-surface-variant">
                    {t.description}
                  </p>
                ) : null}
                <p className="mt-0.5 truncate text-[11px] font-semibold text-primary">
                  {t.role}
                </p>
              </div>

              {hasActions ? (
                <div className="flex shrink-0 items-center gap-2">
                  {onClone ? (
                    <button
                      type="button"
                      onClick={() => onClone(t.id)}
                      aria-label={`${t.name} を複製`}
                      className="inline-flex h-8 items-center rounded-md border border-primary px-3 text-label-md font-semibold text-primary transition-colors hover:bg-primary-container"
                    >
                      複製
                    </button>
                  ) : null}
                  {onEdit ? (
                    <button
                      type="button"
                      onClick={() => onEdit(t.id)}
                      aria-label={`${t.name} を編集`}
                      className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-label-md font-semibold text-on-primary transition-colors hover:bg-[#1E54D8]"
                    >
                      編集
                    </button>
                  ) : null}
                  {onDelete ? (
                    <button
                      type="button"
                      onClick={() => onDelete(t.id)}
                      aria-label={`${t.name} を削除`}
                      className="inline-flex h-8 items-center rounded-md border border-error px-3 text-label-md font-semibold text-error transition-colors hover:bg-[#FEE2E2]"
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
