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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  ScheduleBuilder,
  type CronActionMeta,
  type CronTargetAction,
} from "./ScheduleBuilder";

export interface ScheduleBuilderContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

interface CreatePayload {
  readonly name: string;
  readonly cron_expression: string;
  readonly target_action: CronTargetAction;
}

/** API の detail を利用者向け文言として取り出す (文字列、または FastAPI 検証エラーの配列)。 */
function apiDetail(e: ApiError): string | null {
  const d = (e.payload as { detail?: unknown } | undefined)?.detail;
  if (typeof d === "string" && d.trim()) return d;
  if (Array.isArray(d)) {
    const msgs = d
      .map((x) => (x && typeof x === "object" && "msg" in x ? String((x as { msg: unknown }).msg) : ""))
      .filter(Boolean);
    if (msgs.length) return msgs.join(" / ");
  }
  return null;
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
      // GAP-258: 422 は API が「どこが悪いか」を日本語で指す (「分の指定が空です: '0,,5'」等)。
      // 固定文に潰すと直し方が分からない (本番実走 SO01-405)
      const detail = e instanceof ApiError && e.status === 422 ? apiDetail(e) : null;
      setError(
        e instanceof ApiError && e.status === 403
          ? "スケジュールを作成する権限がありません。"
          : detail
            ? `入力内容を確認してください: ${detail}`
            : "スケジュールの作成に失敗しました。入力内容を確認してください。",
      );
    },
  });

  // GAP-292 (通し J44-01): 種類の文言・コストは GET /cron-actions が唯一の信頼源
  const actionsQuery = useQuery({
    queryKey: ["cron-actions"],
    queryFn: async () => {
      const res = await client.get("/cron-actions");
      const data = (res as { data?: unknown }).data;
      return Array.isArray(data) ? (data as CronActionMeta[]) : [];
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <ScheduleBuilder
      onCreate={(p) => createMut.mutate(p)}
      {...(actionsQuery.data ? { actions: actionsQuery.data } : {})}
      submitting={createMut.isPending}
      error={error}
    />
  );
}
