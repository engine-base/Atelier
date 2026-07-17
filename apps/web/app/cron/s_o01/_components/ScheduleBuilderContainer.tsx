/**
 * S-O01 新規スケジュール作成 コンテナ — 実 cron-schedules API 配線 (T-A-40)
 *
 * POST /cron-schedules でスケジュールを作成し、成功で一覧
 * (["cron-schedules", projectId]) を invalidate して即反映する。
 * 以前は ScheduleBuilder が送信配線を持たない静的 UI で「作成」ボタンが機能しなかった。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { ScheduleBuilder, type CronTargetAction } from "./ScheduleBuilder";

export interface ScheduleBuilderContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

interface CreatePayload {
  readonly name: string;
  readonly cron_expression: string;
  readonly target_action: CronTargetAction;
}

export function ScheduleBuilderContainer({
  projectId,
  client: injected,
}: ScheduleBuilderContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (p: CreatePayload) =>
      client.post("/cron-schedules", {
        body: {
          project_id: projectId,
          name: p.name,
          cron_expression: p.cron_expression,
          target_action: p.target_action,
          target_payload: {},
          enabled: true,
        },
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: ["cron-schedules", projectId],
      });
    },
    onError: (e) => {
      setError(
        e instanceof ApiError && e.status === 403
          ? "スケジュールを作成する権限がありません。"
          : "スケジュールの作成に失敗しました。入力内容を確認してください。",
      );
    },
  });

  return (
    <ScheduleBuilder
      onCreate={(p) => createMut.mutate(p)}
      submitting={createMut.isPending}
      error={error}
    />
  );
}
