/**
 * S-I01 タスクボード (6 列・再生バー) — T-UC-14
 *
 * - 6 列 lifecycle (backlog / ready / in_progress / awaiting / done / blocked)
 * - 各列にタスクカード一覧
 * - 再生バーはヘッダに play ボタン (実 API 連携は別 PR で apiClient.post('/tasks/{id}/play'))
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";

export type TaskStage =
  | "backlog"
  | "ready"
  | "in_progress"
  | "awaiting"
  | "done"
  | "blocked";

export interface TaskCard {
  readonly id: string;
  readonly title: string;
  readonly stage: TaskStage;
  readonly assignee?: string;
}

export interface KanbanBoardProps {
  readonly tasks: readonly TaskCard[];
  readonly onPlay?: (taskId: string) => void;
}

export const STAGE_ORDER: readonly TaskStage[] = [
  "backlog",
  "ready",
  "in_progress",
  "awaiting",
  "done",
  "blocked",
];

const STAGE_LABEL: Record<TaskStage, string> = {
  backlog: "バックログ",
  ready: "実行可",
  in_progress: "進行中",
  awaiting: "承認待ち",
  done: "完了",
  blocked: "ブロック",
};

const STAGE_BG: Record<TaskStage, string> = {
  backlog: "bg-surface-variant/30",
  ready: "bg-primary-container/30",
  in_progress: "bg-primary-container",
  awaiting: "bg-secondary-container",
  done: "bg-tertiary-container/50",
  blocked: "bg-error/10",
};

export function KanbanBoard({ tasks, onPlay }: KanbanBoardProps) {
  const byStage = STAGE_ORDER.map((s) => ({
    stage: s,
    tasks: tasks.filter((t) => t.stage === s),
  }));
  return (
    <div
      role="group"
      aria-label="タスクボード"
      className="flex gap-md overflow-x-auto"
    >
      {byStage.map(({ stage, tasks: ts }) => (
        <section
          key={stage}
          aria-label={STAGE_LABEL[stage]}
          className={cn(
            "flex min-w-48 flex-col gap-sm rounded-md p-sm",
            STAGE_BG[stage],
          )}
        >
          <header className="flex items-center justify-between text-label-md font-semibold text-on-surface">
            <span>{STAGE_LABEL[stage]}</span>
            <span className="text-on-surface-variant">{ts.length}</span>
          </header>
          <ul role="list" className="flex flex-col gap-xs">
            {ts.map((t) => (
              <li
                key={t.id}
                className="rounded-md bg-surface p-sm shadow-[var(--shadow-e1)]"
              >
                <p className="text-body-sm font-semibold text-on-surface">
                  {t.title}
                </p>
                {t.assignee ? (
                  <p className="text-label-sm text-on-surface-variant">
                    {t.assignee}
                  </p>
                ) : null}
                {onPlay && (stage === "ready" || stage === "blocked") ? (
                  <button
                    type="button"
                    onClick={() => onPlay(t.id)}
                    aria-label={`${t.title} を実行`}
                    className="mt-xs inline-flex h-7 items-center rounded-sm bg-primary px-sm text-label-sm text-primary-fg"
                  >
                    ▶ 再生
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
