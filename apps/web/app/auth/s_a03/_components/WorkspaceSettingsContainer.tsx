/**
 * S-A03 ワークスペース設定 コンテナ — T-UC-02 (実 workspaces / ai-learning API 配線)
 *
 * GET /workspaces/{id} で名称を取得し、保存で:
 *   - PATCH /workspaces/{id} {name}
 *   - POST  /account/ai-learning {opt_out}   （AI 学習オプトアウト, 既定 ON = rule #6）
 * を実行する。WS 削除 API は無いため削除ボタンは出さない。
 * AI 学習状態の取得 API は無く、既定は opt-out=true（学習に使わない）。
 * api client は注入可能。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  WorkspaceSettingsForm,
  type WorkspaceSettingsValues,
} from "./WorkspaceSettingsForm";

interface ApiWorkspace {
  name: string;
}

export interface WorkspaceSettingsContainerProps {
  readonly workspaceId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function WorkspaceSettingsContainer({
  workspaceId,
  client: injected,
}: WorkspaceSettingsContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const KEY = ["workspace", workspaceId] as const;

  const ws = useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await client.get("/workspaces/{workspace_id}", {
        params: { path: { workspace_id: workspaceId } },
      });
      return (res as { data?: ApiWorkspace }).data ?? null;
    },
    retry: false,
  });

  // 楽観更新: 保存前に workspace 名をキャッシュへ即時反映、失敗時に戻す。
  const saveMut = useMutation({
    mutationFn: async (v: WorkspaceSettingsValues) => {
      await client.patch("/workspaces/{workspace_id}", {
        params: { path: { workspace_id: workspaceId } },
        body: { name: v.name },
      });
      // AI 学習オプトアウトはアカウント単位（rule #6: 既定 OFF を維持）。
      await client.post("/account/ai-learning", {
        body: { opt_out: v.aiLearningOptOut },
      });
    },
    onMutate: async (v) => {
      setServerError(null);
      await queryClient.cancelQueries({ queryKey: KEY });
      const prev = queryClient.getQueryData<ApiWorkspace>(KEY);
      queryClient.setQueryData<ApiWorkspace>(KEY, (old) =>
        old ? { ...old, name: v.name } : old,
      );
      return { prev };
    },
    onError: (error, _v, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(KEY, ctx.prev);
      setServerError(
        error instanceof ApiError && error.status === 403
          ? "設定を変更する権限がありません。"
          : "設定の保存に失敗しました。時間をおいて再度お試しください。",
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  const onSubmit = async (v: WorkspaceSettingsValues): Promise<void> => {
    await saveMut.mutateAsync(v).catch(() => undefined);
  };

  if (isForbidden(ws.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このワークスペースの設定にアクセスする権限がありません。
      </p>
    );
  }
  if (ws.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        ワークスペースの取得に失敗しました。
      </p>
    );
  }
  if (ws.isLoading || !ws.data) {
    return <Loading className="py-md" />;
  }

  // AI 学習は既定でオプトアウト（学習に使わない）。取得 API が無いため true 初期化。
  const initial: WorkspaceSettingsValues = {
    name: ws.data.name,
    aiLearningOptOut: true,
  };

  return (
    <WorkspaceSettingsForm
      defaultValues={initial}
      onSubmit={onSubmit}
      serverError={serverError}
    />
  );
}
