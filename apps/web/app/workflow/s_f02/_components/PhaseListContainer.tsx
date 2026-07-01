/**
 * S-F02 フェーズ管理 コンテナ — T-UC-11 (実 workflow API 配線)
 *
 * GET /workflow/phases?project_id で工程一覧、PATCH /workflow/phases/{id} {status} で
 * 状態遷移（楽観更新＋失敗時ロールバック）。UI 状態(done/blocked)と API 状態
 * (completed/skipped)を相互変換する。api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { PhaseList, type PhaseRow, type PhaseStatus } from "./PhaseList";

interface ApiPhase {
  id: string;
  name: string;
  status: string;
  order_index?: number;
  order?: number;
}

const KEY = (projectId: string) => ["workflow-phases", projectId] as const;

type ApiPhaseStatus = "pending" | "in_progress" | "completed" | "skipped";

function toUi(status: string): PhaseStatus {
  if (status === "completed") return "done";
  if (status === "skipped") return "blocked";
  if (status === "in_progress") return "in_progress";
  return "pending";
}
function toApi(status: PhaseStatus): ApiPhaseStatus {
  if (status === "done") return "completed";
  if (status === "blocked") return "skipped";
  return status;
}

export interface PhaseListContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function PhaseListContainer({
  projectId,
  client: injected,
}: PhaseListContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: KEY(projectId),
    queryFn: async () => {
      const res = await client.get("/workflow/phases", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: ApiPhase[] }).data ?? [];
    },
    retry: false,
  });

  const transitionMut = useMutation({
    mutationFn: (vars: { id: string; status: PhaseStatus }) =>
      client.patch("/workflow/phases/{phase_id}", {
        params: { path: { phase_id: vars.id } },
        body: { status: toApi(vars.status) },
      }),
    // 楽観更新: 状態を即座に反映、失敗時に元へ戻す。
    onMutate: async (vars) => {
      const key = KEY(projectId);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ApiPhase[]>(key);
      queryClient.setQueryData<ApiPhase[]>(key, (old) =>
        (old ?? []).map((p) =>
          p.id === vars.id ? { ...p, status: toApi(vars.status) } : p,
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

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このプロジェクトの工程にアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        工程の取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const rows: PhaseRow[] = (list.data ?? []).map((p, i) => ({
    id: p.id,
    name: p.name,
    status: toUi(p.status),
    order: p.order_index ?? p.order ?? i + 1,
  }));

  return (
    <PhaseList
      rows={rows}
      onTransition={(id, status) => transitionMut.mutate({ id, status })}
    />
  );
}
