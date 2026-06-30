/**
 * S-I02 タスク詳細 (6 タブ) — T-UC-15
 *
 * - tabs: 概要 / 仕様 / 入出力 / 実行履歴 / 添付 / コメント
 * - tab role + aria-controls + aria-selected で a11y 準拠
 * - 各タブの中身は content map（コンテナが実 API から構築）で受け取る。
 */

"use client";

import * as React from "react";
import { useId, useState } from "react";

import { cn } from "../../../../lib/cn";

const TABS = [
  { id: "overview", label: "概要" },
  { id: "spec", label: "仕様" },
  { id: "io", label: "入出力" },
  { id: "history", label: "実行履歴" },
  { id: "files", label: "添付" },
  { id: "comments", label: "コメント" },
] as const;

export type TaskTabId = (typeof TABS)[number]["id"];

export interface TaskDetailTabsProps {
  readonly title: string;
  /** タブ ID ごとの中身。未指定タブは「情報なし」を表示する。 */
  readonly content?: Partial<Record<TaskTabId, React.ReactNode>>;
}

export function TaskDetailTabs({ title, content }: TaskDetailTabsProps) {
  const [active, setActive] = useState<TaskTabId>("overview");
  const baseId = useId();

  return (
    <div className="flex flex-col gap-md">
      <h1 className="text-headline-md font-bold text-on-surface">{title}</h1>
      <div
        role="tablist"
        aria-label="タスク詳細タブ"
        className="flex border-b border-surface-variant"
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            id={`${baseId}-${tab.id}-tab`}
            aria-selected={active === tab.id}
            aria-controls={`${baseId}-${tab.id}-panel`}
            tabIndex={active === tab.id ? 0 : -1}
            onClick={() => setActive(tab.id)}
            className={cn(
              "px-md py-xs text-label-lg",
              active === tab.id
                ? "border-b-2 border-primary font-semibold text-primary"
                : "text-on-surface-variant",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {TABS.map((tab) => (
        <section
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-${tab.id}-panel`}
          aria-labelledby={`${baseId}-${tab.id}-tab`}
          hidden={active !== tab.id}
          className="rounded-md bg-surface-variant/20 p-md"
        >
          {content?.[tab.id] ?? (
            <p className="text-body-md text-on-surface-variant">
              {tab.label}に表示できる情報はありません。
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
