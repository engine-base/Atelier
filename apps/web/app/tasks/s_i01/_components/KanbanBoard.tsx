/**
 * S-I01 タスクボード (かんばん) — T-UC-14 / F-VIS
 *
 * モック 06_mockups/task/S-I01-kanban.html 準拠:
 *   - 選択バー: 「n 件のタスクを選択中・合計見積 n 時間」+「選択を再生する n件」
 *     (着手可カードのチェックボックスで選択 → onPlaySelected が実 play API を叩く)
 *   - ツールバー: かんばん/リスト切替 · 分類 (機能別/担当AI別/フェーズ別/なし) ·
 *     絞り込み · 全 n 件 · タスクを追加
 *   - 分類グループごとに 6 レーン (準備中/着手可/実装中/要対応/承認待ち/完了) + 完了%
 *   - カード: タイトル + ID + 見積 (未見積) + 担当アバター。要対応は赤枠 +
 *     blocked_reason + 再試行。実装中は dispatch 状態行。
 * レーン名はモック凡例と同一語 (旧: バックログ/実行可/進行中/ブロック — 凡例と
 * 不一致だった)。presentational — API 呼出は TaskBoardContainer が担う。
 * モックの「依存グラフ」ビューはタスク依存 API が無いため出さない (gap-tracker)。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import {
  Filter,
  Kanban as KanbanIcon,
  List,
  Play,
  Plus,
  RotateCcw,
} from "lucide-react";

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
  readonly assigneeColor?: string;
  readonly category?: string;
  readonly phase?: string;
  readonly estimatedHours?: number | null;
  readonly priority?: string;
  readonly blockedReason?: string | null;
  readonly dispatchStatus?: string | null;
}

export type BoardView = "kanban" | "list";
export type BoardGrouping = "none" | "category" | "assignee" | "phase";

export interface KanbanBoardProps {
  readonly tasks: readonly TaskCard[];
  readonly onPlay?: (taskId: string) => void;
  /** 選択した着手可タスクの一括再生 (モックの「選択を再生する」)。 */
  readonly onPlaySelected?: (taskIds: readonly string[]) => void;
  /** 要対応カードの再試行 (POST /tasks/{id}/retry)。 */
  readonly onRetry?: (taskId: string) => void;
  /** タスク追加モーダルを開く (未指定なら「タスクを追加」を出さない)。 */
  readonly onAddTask?: () => void;
  readonly playing?: boolean;
}

/** レーン表示順 (モック凡例と同一): 準備中→着手可→実装中→要対応→承認待ち→完了。 */
export const STAGE_ORDER: readonly TaskStage[] = [
  "backlog",
  "ready",
  "in_progress",
  "blocked",
  "awaiting",
  "done",
];

/** レーン名 = 凡例と同一語 (モック準拠。旧ラベルは凡例と食い違っていた)。 */
const STAGE_LABEL: Record<TaskStage, string> = {
  backlog: "準備中",
  ready: "着手可",
  in_progress: "実装中",
  blocked: "要対応",
  awaiting: "承認待ち",
  done: "完了",
};

const STAGE_DOT: Record<TaskStage, string> = {
  backlog: "bg-neutral",
  ready: "bg-on-surface-variant",
  in_progress: "bg-primary",
  blocked: "bg-error",
  awaiting: "bg-secondary",
  done: "bg-tertiary",
};

const GROUPINGS: readonly { key: BoardGrouping; label: string }[] = [
  { key: "category", label: "機能別" },
  { key: "assignee", label: "担当 AI 別" },
  { key: "phase", label: "フェーズ別" },
  { key: "none", label: "分類なし" },
];

function groupKeyOf(task: TaskCard, grouping: BoardGrouping): string {
  if (grouping === "category") return task.category ?? "未分類";
  if (grouping === "assignee") return task.assignee ?? "未割当";
  if (grouping === "phase") return task.phase ?? "フェーズ未設定";
  return "";
}

function TaskCardItem({
  task,
  onPlay,
  onRetry,
  selected,
  onToggleSelect,
}: {
  readonly task: TaskCard;
  readonly onPlay?: (taskId: string) => void;
  readonly onRetry?: (taskId: string) => void;
  readonly selected: boolean;
  readonly onToggleSelect?: (taskId: string) => void;
}) {
  const selectable = task.stage === "ready" && Boolean(onToggleSelect);
  const canPlay =
    Boolean(onPlay) && (task.stage === "ready" || task.stage === "blocked");
  return (
    <li
      className={cn(
        "group relative rounded-md border bg-white px-3 py-2.5 transition-all hover:-translate-y-px hover:shadow-sm",
        task.stage === "blocked"
          ? "border-error/60 hover:border-error"
          : selected
            ? "border-primary ring-2 ring-primary-container"
            : "border-border hover:border-primary",
      )}
    >
      <div className="mb-1.5 flex items-start gap-2">
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(task.id)}
            aria-label={`${task.title} を選択`}
            className="mt-0.5 h-3.5 w-3.5 accent-[#2563EB]"
          />
        ) : null}
        <p className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-on-surface">
          {task.title}
        </p>
      </div>
      <div className="flex items-center gap-1.5 text-[10.5px] text-on-surface-variant">
        <span className="font-mono text-[10px]" title={task.id}>
          #{task.id.slice(0, 8)}
        </span>
        <span className="tabular-nums">
          {typeof task.estimatedHours === "number"
            ? `見積 ${task.estimatedHours} 時間`
            : "未見積"}
        </span>
        <span className="flex-1" />
        {task.assignee ? (
          <span
            aria-hidden="true"
            title={task.assignee}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
            style={{ backgroundColor: task.assigneeColor ?? "#2563EB" }}
          >
            {task.assignee.trim().charAt(0)}
          </span>
        ) : null}
      </div>
      {task.stage === "in_progress" && task.dispatchStatus ? (
        <p className="mt-1.5 border-t border-border pt-1.5 text-[10.5px] font-semibold text-primary">
          {task.assignee ?? "AI 社員"} が実装中 · {task.dispatchStatus}
        </p>
      ) : null}
      {task.stage === "blocked" ? (
        <div className="mt-1.5 border-t border-error/30 pt-1.5">
          {task.blockedReason ? (
            <p className="mb-1 text-[10.5px] font-semibold text-error">
              {task.blockedReason}
            </p>
          ) : null}
          {onRetry ? (
            <button
              type="button"
              onClick={() => onRetry(task.id)}
              className="inline-flex items-center gap-1 rounded-sm bg-error/10 px-2 py-0.5 text-[10.5px] font-bold text-error hover:bg-error/20"
            >
              <RotateCcw aria-hidden="true" className="h-3 w-3" />
              再試行
            </button>
          ) : null}
        </div>
      ) : null}
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

function LaneGrid({
  tasks,
  onPlay,
  onRetry,
  selectedIds,
  onToggleSelect,
}: {
  readonly tasks: readonly TaskCard[];
  readonly onPlay?: (taskId: string) => void;
  readonly onRetry?: (taskId: string) => void;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggleSelect?: (taskId: string) => void;
}) {
  return (
    <div className="flex gap-2 overflow-x-auto">
      {STAGE_ORDER.map((stage) => {
        const ts = tasks.filter((t) => t.stage === stage);
        return (
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
              <span className="text-[11px] font-semibold tabular-nums text-on-surface-variant">
                {ts.length}
              </span>
            </header>
            <ul role="list" className="flex flex-col gap-1.5">
              {ts.map((t) => (
                <TaskCardItem
                  key={t.id}
                  task={t}
                  onPlay={onPlay}
                  onRetry={onRetry}
                  selected={selectedIds.has(t.id)}
                  onToggleSelect={onToggleSelect}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function KanbanBoard({
  tasks,
  onPlay,
  onPlaySelected,
  onRetry,
  onAddTask,
  playing = false,
}: KanbanBoardProps) {
  const [view, setView] = useState<BoardView>("kanban");
  const [grouping, setGrouping] = useState<BoardGrouping>("category");
  const [filter, setFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        (t.category ?? "").toLowerCase().includes(q) ||
        (t.assignee ?? "").toLowerCase().includes(q),
    );
  }, [tasks, filter]);

  const groups = useMemo(() => {
    if (grouping === "none") return [{ key: "", tasks: filtered }];
    const map = new Map<string, TaskCard[]>();
    for (const t of filtered) {
      const k = groupKeyOf(t, grouping);
      map.set(k, [...(map.get(k) ?? []), t]);
    }
    return [...map.entries()].map(([key, ts]) => ({ key, tasks: ts }));
  }, [filtered, grouping]);

  const selected = tasks.filter(
    (t) => selectedIds.has(t.id) && t.stage === "ready",
  );
  const selectedHours = selected.reduce(
    (sum, t) => sum + (t.estimatedHours ?? 0),
    0,
  );
  const runningCount = tasks.filter((t) => t.stage === "in_progress").length;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 選択バー (モック .selection-bar) — 選択があるときのみ */}
      {selected.length > 0 && onPlaySelected ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary bg-primary-container/50 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-bold text-on-surface">
              {selected.length} 件のタスクを選択中 · 合計見積 {selectedHours} 時間
            </p>
            <p className="text-[11.5px] text-on-surface-variant">
              「再生」を押すと、選んだタスクが AI 社員にディスパッチされます。停止はいつでも可能です。
            </p>
          </div>
          <span className="text-[11.5px] font-semibold tabular-nums text-on-surface-variant">
            実装中 いま {runningCount} 件
          </span>
          <button
            type="button"
            disabled={playing}
            onClick={() => {
              onPlaySelected(selected.map((t) => t.id));
              setSelectedIds(new Set());
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-bold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Play aria-hidden="true" className="h-3.5 w-3.5 fill-current" />
            {playing ? "再生中…" : `選択を再生する`}
            <span className="rounded-full bg-white/25 px-1.5 text-[11px] tabular-nums">
              {selected.length}
            </span>
          </button>
        </div>
      ) : null}

      {/* ツールバー (モック .board-toolbar) */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-white px-3 py-2">
        <span className="text-[11.5px] font-semibold text-on-surface-variant">表示</span>
        <div className="flex overflow-hidden rounded-md border border-border">
          {(
            [
              { key: "kanban", label: "かんばん", icon: KanbanIcon },
              { key: "list", label: "リスト", icon: List },
            ] as const
          ).map((v) => (
            <button
              key={v.key}
              type="button"
              aria-pressed={view === v.key}
              onClick={() => setView(v.key)}
              className={cn(
                "inline-flex items-center gap-1 px-3 py-1.5 text-[12px] font-semibold",
                view === v.key
                  ? "bg-primary-container text-on-primary-container"
                  : "text-on-surface-variant hover:bg-surface-variant",
              )}
            >
              <v.icon aria-hidden="true" className="h-3.5 w-3.5" />
              {v.label}
            </button>
          ))}
        </div>
        <span className="ml-2 text-[11.5px] font-semibold text-on-surface-variant">分類</span>
        <div className="flex overflow-hidden rounded-md border border-border">
          {GROUPINGS.map((g) => (
            <button
              key={g.key}
              type="button"
              aria-pressed={grouping === g.key}
              onClick={() => setGrouping(g.key)}
              className={cn(
                "px-3 py-1.5 text-[12px] font-semibold",
                grouping === g.key
                  ? "bg-primary-container text-on-primary-container"
                  : "text-on-surface-variant hover:bg-surface-variant",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <label className="ml-2 flex items-center gap-1.5 rounded-md bg-surface-variant px-2.5 py-1.5">
          <Filter aria-hidden="true" className="h-3.5 w-3.5 text-on-surface-variant" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="絞り込み"
            aria-label="タスクを絞り込み"
            className="w-[100px] border-0 bg-transparent text-[12px] text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </label>
        <span className="ml-auto text-[12px] font-semibold tabular-nums text-on-surface-variant">
          全 {tasks.length} 件のタスク
        </span>
        {onAddTask ? (
          <button
            type="button"
            onClick={onAddTask}
            className="inline-flex items-center gap-1 rounded-md border border-primary px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary-container"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            タスクを追加
          </button>
        ) : null}
      </div>

      {/* 本体 */}
      {view === "list" ? (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-border bg-surface-variant text-left text-[10.5px] uppercase tracking-[0.06em] text-on-surface-variant">
                <th className="px-3 py-2 font-bold">タスク</th>
                <th className="px-3 py-2 font-bold">状態</th>
                <th className="px-3 py-2 font-bold">分類</th>
                <th className="px-3 py-2 font-bold">見積</th>
                <th className="px-3 py-2 font-bold">担当</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-b-0 hover:bg-surface-variant/60">
                  <td className="px-3 py-2 font-medium text-on-surface">{t.title}</td>
                  <td className="px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", STAGE_DOT[t.stage])} />
                      {STAGE_LABEL[t.stage]}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-on-surface-variant">{t.category ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums text-on-surface-variant">
                    {typeof t.estimatedHours === "number" ? `${t.estimatedHours}h` : "未見積"}
                  </td>
                  <td className="px-3 py-2 text-on-surface-variant">{t.assignee ?? "未割当"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div role="group" aria-label="タスクボード" className="flex flex-col gap-4">
          {groups.map(({ key, tasks: ts }) => {
            const doneCount = ts.filter((t) => t.stage === "done").length;
            const pct = ts.length ? Math.round((doneCount / ts.length) * 100) : 0;
            return (
              <section
                key={key || "all"}
                aria-label={key || "全タスク"}
                className="rounded-lg border border-border bg-white p-4"
              >
                {key ? (
                  <header className="mb-3 flex items-center gap-3">
                    <h3 className="text-[14px] font-bold text-on-surface">{key}</h3>
                    <span className="rounded-full bg-surface-variant px-2 py-0.5 text-[10.5px] font-bold tabular-nums text-on-surface-variant">
                      {ts.length} 件
                    </span>
                    <span className="ml-auto flex items-center gap-2 text-[11px] font-semibold tabular-nums text-on-surface-variant">
                      <span className="h-1.5 w-[120px] overflow-hidden rounded-full bg-surface-variant">
                        <span
                          className="block h-full rounded-full bg-tertiary"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      完了 {pct}%
                    </span>
                  </header>
                ) : null}
                <LaneGrid
                  tasks={ts}
                  onPlay={onPlay}
                  onRetry={onRetry}
                  selectedIds={selectedIds}
                  onToggleSelect={onPlaySelected ? toggleSelect : undefined}
                />
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
