/**
 * S-I01 タスクボード (かんばん・状態レーン) — T-UC-14 / F-VIS
 *
 * モック 06_mockups/task/S-I01-kanban.html に忠実な「状態カラム」かんばん。
 * - 6 レーン lifecycle (backlog / ready / in_progress / blocked / awaiting / done)
 *   をモックのレーン順・ドット色・カウントで横並び (横スクロール可)。
 * - タスクカード = タイトル + メタ(モノスペース ID + 担当 avatar)。
 * - ready / blocked カードに「再生」ボタン。onPlay 経由で TaskBoardContainer が
 *   POST /tasks/{id}/play (dispatcher 連動) を呼ぶ。presentational（props で駆動）。
 */

"use client";

import * as React from "react";
import { Play } from "lucide-react";

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

/** レーン表示順 (モックのかんばん左→右: 準備中→着手可→実装中→要対応→承認待ち→完了)。 */
export const STAGE_ORDER: readonly TaskStage[] = [
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "awaiting",
  "done",
];

const STAGE_LABEL: Record<TaskStage, string> = {
  backlog: "バックログ",
  ready: "実行可",
  in_progress: "進行中",
  awaiting: "承認待ち",
  done: "完了",
  blocked: "ブロック",
};

/** レーンヘッダのドット色 (モック .dot.triage/ready/impl/blocked/wait/done)。 */
const STAGE_DOT: Record<TaskStage, string> = {
  backlog: "bg-neutral",
  ready: "bg-on-surface-variant",
  in_progress: "bg-primary",
  blocked: "bg-error",
  awaiting: "bg-secondary",
  done: "bg-tertiary",
};

/** AI 社員色 (atelier.css の .avatar-<name> を踏襲)。 */
const AVATAR_COLOR: Record<string, string> = {
  tony: "bg-[#DC2626]",
  natasha: "bg-[#7C3AED]",
  steve: "bg-[#1E40AF]",
  peter: "bg-[#DC2626]",
  strange: "bg-[#C7A04A]",
  wanda: "bg-[#BE185D]",
  thor: "bg-[#0891B2]",
  vision: "bg-[#16A34A]",
  tchalla: "bg-[#1F2937]",
  jarvis: "bg-primary",
};

function avatarClass(assignee: string): string {
  const key = assignee.toLowerCase();
  for (const name of Object.keys(AVATAR_COLOR)) {
    if (key.includes(name)) return AVATAR_COLOR[name]!;
  }
  return "bg-primary";
}

function avatarInitial(assignee: string): string {
  return assignee.trim().charAt(0).toUpperCase() || "?";
}

function TaskCardItem({
  task,
  onPlay,
}: {
  readonly task: TaskCard;
  readonly onPlay?: (taskId: string) => void;
}) {
  const canPlay =
    Boolean(onPlay) && (task.stage === "ready" || task.stage === "blocked");
  return (
    <li
      className={cn(
        "group relative rounded-md border border-border bg-white px-3 py-2.5",
        "transition-all hover:-translate-y-px hover:border-primary hover:shadow-sm",
      )}
    >
      <p className="mb-1.5 text-[12.5px] font-semibold leading-snug text-on-surface">
        {task.title}
      </p>
      <div className="flex items-center gap-1.5 text-[10.5px] text-on-surface-variant">
        <span className="font-mono text-[10px]" title={task.id}>
          #{task.id.slice(0, 8)}
        </span>
        {task.assignee ? (
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white",
              avatarClass(task.assignee),
            )}
          >
            {avatarInitial(task.assignee)}
          </span>
        ) : null}
        <span className="flex-1" />
      </div>
      {canPlay ? (
        <button
          type="button"
          onClick={() => onPlay?.(task.id)}
          aria-label={`${task.title} を実行`}
          className={cn(
            "absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1",
            "text-[10.5px] font-bold text-primary-fg shadow-sm transition-all",
            "opacity-0 hover:brightness-110 focus-visible:opacity-100 group-hover:opacity-100",
          )}
        >
          <Play aria-hidden="true" className="h-3 w-3 fill-current" />
          再生
        </button>
      ) : null}
    </li>
  );
}

export function KanbanBoard({ tasks, onPlay }: KanbanBoardProps) {
  const byStage = STAGE_ORDER.map((s) => ({
    stage: s,
    tasks: tasks.filter((t) => t.stage === s),
  }));
  return (
    <div className="rounded-lg border border-border bg-white p-4">
      <div
        role="group"
        aria-label="タスクボード"
        className="flex gap-2 overflow-x-auto"
      >
        {byStage.map(({ stage, tasks: ts }) => (
          <section
            key={stage}
            aria-label={STAGE_LABEL[stage]}
            className="flex min-h-[100px] min-w-[184px] flex-1 flex-col rounded-md bg-surface-variant p-2.5"
          >
            <header className="mb-2 flex items-center justify-between px-1">
              <span className="flex items-center gap-1.5 text-[11.5px] font-bold text-on-surface">
                <span
                  aria-hidden="true"
                  className={cn("h-2 w-2 rounded-full", STAGE_DOT[stage])}
                />
                {STAGE_LABEL[stage]}
              </span>
              <span className="text-[11px] font-semibold text-on-surface-variant tabular-nums">
                {ts.length}
              </span>
            </header>
            <ul role="list" className="flex flex-col gap-1.5">
              {ts.map((t) => (
                <TaskCardItem key={t.id} task={t} onPlay={onPlay} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
