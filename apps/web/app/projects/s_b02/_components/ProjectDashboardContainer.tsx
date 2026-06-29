/**
 * S-B02 プロジェクトダッシュボード コンテナ — T-UC-04 (実 projects API 配線)
 *
 * GET /projects/{id}/dashboard の task_counts を KPI タイルへマップし、
 * GET /projects/{id} の name をヘッダに使う。loading/empty/error/403 対応。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { ProjectDashboard, type DashboardKpi } from "./ProjectDashboard";

type TaskCounts = Partial<Record<string, number>>;

export interface ProjectDashboardContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function toKpis(counts: TaskCounts): DashboardKpi[] {
  return [
    { id: "total", label: "総タスク", value: counts.total ?? 0, tone: "info" },
    {
      id: "in_progress",
      label: "進行中",
      value: counts.in_progress ?? 0,
      tone: "info",
    },
    {
      id: "awaiting",
      label: "承認待ち",
      value: counts.awaiting ?? 0,
      tone: "info",
    },
    { id: "done", label: "完了", value: counts.done ?? 0, tone: "success" },
    {
      id: "blocked",
      label: "ブロック",
      value: counts.blocked ?? 0,
      tone: "error",
    },
  ];
}

export function ProjectDashboardContainer({
  projectId,
  client: injected,
}: ProjectDashboardContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const dashboard = useQuery({
    queryKey: ["project", "dashboard", projectId],
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}/dashboard", {
        params: { path: { project_id: projectId } },
      });
      return (res as { data?: { task_counts?: TaskCounts } }).data ?? {};
    },
    retry: false,
  });

  const project = useQuery({
    queryKey: ["project", "detail", projectId],
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}", {
        params: { path: { project_id: projectId } },
      });
      return (res as { data?: { name?: string } }).data ?? {};
    },
    retry: false,
  });

  if (isForbidden(dashboard.error) || isForbidden(project.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このプロジェクトを表示する権限がありません。
      </p>
    );
  }
  if (dashboard.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        ダッシュボードの取得に失敗しました。
      </p>
    );
  }

  const projectName = project.data?.name ?? "プロジェクト";
  const kpis = toKpis(dashboard.data?.task_counts ?? {});

  return (
    <ProjectDashboard
      projectName={projectName}
      kpis={kpis}
      loading={dashboard.isLoading}
    />
  );
}
