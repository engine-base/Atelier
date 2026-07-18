/**
 * S-I01 タスクボード コンテナ — T-UC-14 (実 tasks API 配線)
 *
 * GET /tasks?project_id で全フィールド (category/phase/見積/担当/blocked_reason/
 * dispatch_status) を取得して KanbanBoard へ。実 API 操作:
 *   - 再生 (単体/選択一括): POST /tasks/{id}/play (dispatcher 連動, T-A-24)
 *   - 再試行: POST /tasks/{id}/retry (blocked → ready)
 *   - タスク追加: POST /tasks (モーダル)
 * 担当 AI 社員は /ai-employees を join して名前/カラー表示。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { Loading } from "../../../../components/Loading";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  employeeColor,
  employeeName,
  type EmployeeLike,
} from "../../../../lib/aiEmployees";
import { KanbanBoard, type TaskCard, type TaskStage } from "./KanbanBoard";

interface ApiTask {
  id: string;
  title: string;
  lifecycle_stage: string;
  category?: string | null;
  phase?: string | null;
  estimated_hours?: number | null;
  priority?: string | null;
  assigned_employee_id?: string | null;
  blocked_reason?: string | null;
  dispatch_status?: string | null;
}

const KEY = (projectId: string) => ["tasks", "board", projectId] as const;

function toStage(lifecycle: string): TaskStage {
  // API の triage は UI の準備中レーンに対応。他はそのまま。
  if (lifecycle === "triage") return "backlog";
  const known: readonly TaskStage[] = [
    "ready",
    "in_progress",
    "awaiting",
    "done",
    "blocked",
  ];
  return known.includes(lifecycle as TaskStage)
    ? (lifecycle as TaskStage)
    : "backlog";
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export interface TaskBoardContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

const TASK_TYPES = [
  "feature",
  "screen",
  "foundation",
  "verification",
  "infrastructure",
  "migration",
] as const;

export function TaskBoardContainer({
  projectId,
  client: injected,
}: TaskBoardContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addCategory, setAddCategory] = useState("");
  const [addHours, setAddHours] = useState("4");
  const [addType, setAddType] =
    useState<(typeof TASK_TYPES)[number]>("feature");
  const [addError, setAddError] = useState<string | null>(null);

  // ダイアログの標準操作: Escape でタスク追加モーダルを閉じる
  useEffect(() => {
    if (!adding) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAdding(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [adding]);

  const list = useQuery({
    queryKey: KEY(projectId),
    queryFn: async () => {
      const res = await client.get("/tasks", {
        params: { query: { project_id: projectId, limit: 200 } },
      });
      return asArray<ApiTask>((res as { data?: unknown }).data);
    },
    retry: false,
  });

  const employeesQuery = useQuery({
    queryKey: ["board-employees"],
    queryFn: async () => {
      const res = await client.get("/ai-employees", {});
      return asArray<EmployeeLike>((res as { data?: unknown }).data);
    },
    retry: false,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: KEY(projectId) });

  const playMut = useMutation({
    mutationFn: (taskId: string) =>
      client.post("/tasks/{id}/play", { params: { path: { id: taskId } } }),
    onSuccess: invalidate,
  });

  const playSelectedMut = useMutation({
    mutationFn: async (taskIds: readonly string[]) => {
      for (const id of taskIds) {
        await client.post("/tasks/{id}/play", { params: { path: { id } } });
      }
    },
    onSettled: invalidate,
  });

  const retryMut = useMutation({
    mutationFn: (taskId: string) =>
      client.post("/tasks/{task_id}/retry", {
        params: { path: { task_id: taskId } },
        body: {},
      }),
    onSuccess: invalidate,
  });

  const addMut = useMutation({
    mutationFn: () =>
      client.post("/tasks", {
        body: {
          project_id: projectId,
          category: addCategory.trim() || "general",
          title: addTitle.trim(),
          type: addType,
          estimated_hours: Math.min(24, Math.max(1, Number(addHours) || 4)),
        },
      }),
    onSuccess: () => {
      setAdding(false);
      setAddTitle("");
      setAddCategory("");
      setAddError(null);
      invalidate();
    },
    onError: () => setAddError("タスクの作成に失敗しました。"),
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このプロジェクトのタスクにアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        タスクの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const apiTasks = list.data ?? [];
  if (apiTasks.length === 0 && !adding) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-body-md text-on-surface-variant">
          このプロジェクトにタスクがありません。
        </p>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:opacity-90"
        >
          ＋ タスクを追加
        </button>
      </div>
    );
  }

  const employeeById = new Map(
    (employeesQuery.data ?? []).map((e) => [e.id, e]),
  );

  const tasks: TaskCard[] = apiTasks.map((t) => {
    const emp = t.assigned_employee_id
      ? employeeById.get(t.assigned_employee_id)
      : undefined;
    return {
      id: t.id,
      title: t.title,
      stage: toStage(t.lifecycle_stage),
      category: t.category ?? undefined,
      phase: t.phase ?? undefined,
      estimatedHours: t.estimated_hours ?? null,
      priority: t.priority ?? undefined,
      blockedReason: t.blocked_reason ?? null,
      dispatchStatus: t.dispatch_status ?? null,
      ...(emp
        ? {
            assignee: employeeName(emp) ?? "AI 社員",
            assigneeColor: employeeColor(emp),
          }
        : t.assigned_employee_id
          ? { assignee: t.assigned_employee_id }
          : {}),
    };
  });

  return (
    <>
      <KanbanBoard
        tasks={tasks}
        onPlay={(id) => playMut.mutate(id)}
        onPlaySelected={(ids) => playSelectedMut.mutate(ids)}
        onRetry={(id) => retryMut.mutate(id)}
        onAddTask={() => setAdding(true)}
        playing={playSelectedMut.isPending || playMut.isPending}
      />

      {/* タスク追加モーダル (実 POST /tasks) */}
      {adding ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="タスクを追加"
          className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setAdding(false)}
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (addTitle.trim()) addMut.mutate();
            }}
            className="w-full max-w-[420px] rounded-lg bg-white p-5 shadow-xl"
          >
            <h2 className="mb-3 text-lg font-bold text-on-surface">タスクを追加</h2>
            <label className="mb-3 block">
              <span className="mb-1 block text-label-sm font-medium text-on-surface-variant">
                タイトル
              </span>
              <input
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                className="h-9 w-full rounded-md border border-border px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
              />
            </label>
            <div className="mb-3 grid grid-cols-2 gap-3">
              <label className="block">
                <span className="mb-1 block text-label-sm font-medium text-on-surface-variant">
                  分類 (機能グループ)
                </span>
                <input
                  value={addCategory}
                  onChange={(e) => setAddCategory(e.target.value)}
                  placeholder="hearing 等"
                  className="h-9 w-full rounded-md border border-border px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-label-sm font-medium text-on-surface-variant">
                  見積 (時間)
                </span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  value={addHours}
                  onChange={(e) => setAddHours(e.target.value)}
                  className="h-9 w-full rounded-md border border-border px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
            </div>
            <label className="mb-3 block">
              <span className="mb-1 block text-label-sm font-medium text-on-surface-variant">
                種別
              </span>
              <select
                value={addType}
                onChange={(e) =>
                  setAddType(e.target.value as (typeof TASK_TYPES)[number])
                }
                className="h-9 w-full rounded-md border border-border bg-white px-2 text-body-sm text-on-surface focus:border-primary focus:outline-none"
              >
                {TASK_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {addError ? (
              <p role="alert" className="mb-2 text-body-sm text-error">
                {addError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded-md border border-border px-4 py-2 text-sm font-semibold text-on-surface hover:border-primary"
              >
                キャンセル
              </button>
              <button
                type="submit"
                disabled={!addTitle.trim() || addMut.isPending}
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:opacity-90 disabled:opacity-50"
              >
                {addMut.isPending ? "作成中…" : "作成"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
