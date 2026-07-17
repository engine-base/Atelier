/**
 * S-O01 自動スケジュール コンテナ — T-UC-25 (実 cron-schedules API 配線)
 *
 * GET /cron-schedules?project_id=<id> で一覧、PATCH /cron-schedules/{id} {enabled} で
 * 有効/無効トグル → 再取得。即時実行(run-now)は専用エンドポイントが無いため列を出さない。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { CronSchedule, type CronJob } from "./CronSchedule";

interface ApiCron {
  id: string;
  name: string;
  cron_expression: string;
  enabled: boolean;
  next_run_at?: string | null;
}

const KEY = (projectId: string) => ["cron-schedules", projectId] as const;

export interface CronScheduleContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function CronScheduleContainer({
  projectId,
  client: injected,
}: CronScheduleContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: KEY(projectId),
    queryFn: async () => {
      const res = await client.get("/cron-schedules", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: ApiCron[] }).data ?? [];
    },
    retry: false,
  });

  const toggleMut = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      client.patch("/cron-schedules/{schedule_id}", {
        params: { path: { schedule_id: vars.id } },
        body: { enabled: vars.enabled },
      }),
    // 楽観更新: 対象ジョブの enabled を即座に反映。失敗時は元に戻す。
    onMutate: async (vars) => {
      const key = KEY(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ApiCron[]>(key);
      queryClient.setQueryData<ApiCron[]>(key, (old) =>
        (old ?? []).map((j) =>
          j.id === vars.id ? { ...j, enabled: vars.enabled } : j,
        ),
      );
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY(projectId), ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: KEY(projectId) }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/cron-schedules/{schedule_id}", {
        params: { path: { schedule_id: id } },
      }),
    onMutate: async (id) => {
      const key = KEY(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ApiCron[]>(key);
      queryClient.setQueryData<ApiCron[]>(key, (old) =>
        (old ?? []).filter((j) => j.id !== id),
      );
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY(projectId), ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: KEY(projectId) }),
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このプロジェクトのスケジュールにアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        スケジュールの取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const apiJobs = list.data ?? [];
  if (apiJobs.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        スケジュールがまだありません。
      </p>
    );
  }

  const jobs: CronJob[] = apiJobs.map((j) => ({
    id: j.id,
    name: j.name,
    schedule: j.cron_expression,
    enabled: j.enabled,
    nextRunAt: j.next_run_at
      ? j.next_run_at.slice(0, 16).replace("T", " ")
      : "—",
  }));

  return (
    <CronSchedule
      jobs={jobs}
      onToggle={(id, enabled) => toggleMut.mutate({ id, enabled })}
      onDelete={(id) => deleteMut.mutate(id)}
    />
  );
}
