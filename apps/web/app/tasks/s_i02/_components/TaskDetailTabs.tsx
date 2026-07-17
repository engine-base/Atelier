/**
 * S-I02 タスク詳細 (6 タブ) — T-UC-15 / F-VIS 是正
 *
 * モック 06_mockups/task/S-I02-detail.html の `.tab-bar` / `.tab` / `.tab-body` に
 * 忠実なタブ UI で描画する。
 * - tabs: 概要 / 仕様 / 入出力 / 実行履歴 / 添付 / コメント
 * - tab role + aria-controls + aria-selected で a11y 準拠
 * - 各タブの中身は content map（コンテナが実 API から構築）で受け取る。
 * - タイトル見出しは上位（TaskDetailContainer のタスクヘッダ）が担うため
 *   本コンポーネントは heading を持たない。title は data 属性で保持する。
 */

"use client";

import * as React from "react";
import { useId, useState } from "react";
import {
  Activity,
  ArrowLeftRight,
  FileText,
  ListChecks,
  MessageSquare,
  Paperclip,
} from "lucide-react";

import { cn } from "../../../../lib/cn";

const TABS = [
  { id: "overview", label: "概要", icon: FileText },
  { id: "spec", label: "仕様", icon: ListChecks },
  { id: "io", label: "入出力", icon: ArrowLeftRight },
  { id: "history", label: "実行履歴", icon: Activity },
  { id: "files", label: "添付", icon: Paperclip },
  { id: "comments", label: "コメント", icon: MessageSquare },
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
    <div className="flex flex-col" data-task-title={title}>
      {/* ── タブバー (モック .tab-bar) ── */}
      <div
        role="tablist"
        aria-label="タスク詳細タブ"
        className="flex gap-1 overflow-x-auto rounded-t-lg border border-b-0 border-border bg-white px-1.5 pt-1.5"
      >
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${baseId}-${tab.id}-tab`}
              aria-selected={isActive}
              aria-controls={`${baseId}-${tab.id}-panel`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(tab.id)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-t-md border-b-[3px] px-4 pb-3 pt-3 text-body-sm font-semibold transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
                isActive
                  ? "border-primary bg-primary-container text-primary"
                  : "border-transparent text-on-surface-variant hover:bg-surface-variant hover:text-on-surface",
              )}
            >
              <Icon size={16} strokeWidth={2} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── タブ本文 (モック .tab-body) ── */}
      {TABS.map((tab) => (
        <section
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-${tab.id}-panel`}
          aria-labelledby={`${baseId}-${tab.id}-tab`}
          hidden={active !== tab.id}
          className="min-h-[480px] rounded-b-lg border border-t-0 border-border bg-white px-7 pb-7 pt-6"
        >
          {content?.[tab.id] ?? (
            <p className="py-12 text-center text-body-md text-on-surface-variant">
              {tab.label}に表示できる情報はありません。
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
