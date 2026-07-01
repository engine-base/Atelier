/**
 * S-I01 タスクボード コンテナ — T-UC-14 (実 tasks API 配線)
 *
 * GET /tasks?project_id=<id> で取得し、lifecycle_stage を 6 列(KanbanBoard)へマップ。
 * 再生バーの play は POST /tasks/{id}/play (dispatcher 連動, T-A-24) を呼び、成功で再取得。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { KanbanBoard, type TaskCard, type TaskStage } from "./KanbanBoard";

interface ApiTask {
  id: string;
  title: string;
  lifecycle_stage: string;
  assigned_employee_id?: string | null;
}

const KEY = (projectId: string) => ["tasks", "board", projectId] as const;

function toStage(lifecycle: string): TaskStage {
  // API の triage は UI のバックログ列に対応。他はそのまま。
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

export interface TaskBoardContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function TaskBoardContainer({
  projectId,
  client: injected,
}: TaskBoardContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: KEY(projectId),
    queryFn: async () => {
      const res = await client.get("/tasks", {
        params: { query: { project_id: projectId, limit: 200 } },
      });
      return (res as { data?: ApiTask[] }).data ?? [];
    },
    retry: false,
  });

  const playMut = useMutation({
    mutationFn: (taskId: string) =>
      client.post("/tasks/{id}/play", { params: { path: { id: taskId } } }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: KEY(projectId) }),
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
  if (apiTasks.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        このプロジェクトにタスクがありません。
      </p>
    );
  }

  const tasks: TaskCard[] = apiTasks.map((t) => ({
    id: t.id,
    title: t.title,
    stage: toStage(t.lifecycle_stage),
    ...(t.assigned_employee_id ? { assignee: t.assigned_employee_id } : {}),
  }));

  return <KanbanBoard tasks={tasks} onPlay={(id) => playMut.mutate(id)} />;
}
