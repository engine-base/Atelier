/**
 * S-I02 タスク詳細タブ — T-UC-15 / design-audit v2
 *
 * モック 06_mockups/task/S-I02-detail.html の `.tab-bar` / `.tab` / `.tab-body` に
 * 忠実なタブ UI。タブ構成はモック準拠 + 実 API の裏付けがあるものだけ:
 *   受入条件 / 進捗・スコア / 依存タスク / 実行履歴 / コメント
 * (モックの「テスト結果」「関連資料」は供給 API 不在のため未描画 — GAP-025。
 *  旧実装の「概要/入出力/添付」タブは撤去: 概要はヘッダーへ、入出力/添付は
 *  裏付け API が無い死にタブだった)
 * - tab role + aria-controls + aria-selected で a11y 準拠
 * - counts でモックの .tab-count バッジ (例 "10 / 12") を描画
 * - 各タブの中身は content map（コンテナが実 API から構築）で受け取る。
 */

"use client";

import * as React from "react";
import { useId, useState } from "react";
import {
  Activity,
  GitBranch,
  ListChecks,
  MessageSquare,
  TrendingUp,
} from "lucide-react";

import { cn } from "../../../../lib/cn";

const TABS = [
  { id: "ac", label: "受入条件", icon: ListChecks },
  { id: "progress", label: "進捗・スコア", icon: TrendingUp },
  { id: "deps", label: "依存タスク", icon: GitBranch },
  { id: "history", label: "実行履歴", icon: Activity },
  { id: "comments", label: "コメント", icon: MessageSquare },
] as const;

export type TaskTabId = (typeof TABS)[number]["id"];

export interface TaskDetailTabsProps {
  readonly title: string;
  /** タブ ID ごとの中身。未指定タブは「情報なし」を表示する。 */
  readonly content?: Partial<Record<TaskTabId, React.ReactNode>>;
  /** タブ ID ごとの件数バッジ (モック .tab-count。例 "10 / 12", "5")。 */
  readonly counts?: Partial<Record<TaskTabId, string>>;
}

export function TaskDetailTabs({ title, content, counts }: TaskDetailTabsProps) {
  const [active, setActive] = useState<TaskTabId>("ac");
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
          const count = counts?.[tab.id];
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
                "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-t-md border-b-[3px] px-4 pb-3 pt-3 text-body-sm font-semibold transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
                isActive
                  ? "border-primary bg-primary-container text-primary"
                  : "border-transparent text-on-surface-variant hover:bg-surface-variant hover:text-on-surface",
              )}
            >
              <Icon size={16} strokeWidth={2} aria-hidden="true" />
              {tab.label}
              {count ? (
                <span
                  className={cn(
                    "rounded-full px-2 py-px text-[10.5px] font-bold tabular-nums",
                    isActive
                      ? "bg-primary text-on-primary"
                      : "bg-surface-variant text-on-surface-variant",
                  )}
                >
                  {count}
                </span>
              ) : null}
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
          className="min-h-[420px] rounded-b-lg border border-t-0 border-border bg-white px-4 pb-7 pt-6 sm:px-7"
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
