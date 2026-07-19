/**
 * S-A03 ワークスペース設定 コンテナ — T-UC-02 (design-audit v2: 実 API 全配線)
 *
 * GET /workspaces/{id} で名称、GET /me で AI 学習の実値 (ai_learning_opt_out) を取得。
 * 保存で PATCH /workspaces/{id} {name} + POST /account/ai-learning {opt_out}。
 * 削除は DELETE /workspaces/{id} (論理・30日 grace) — v2 で UI 断線を解消
 * (API が実在するのに削除ボタンが無かった)。api client は注入可能。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { MembersSection } from "./MembersSection";
import { McpTokensSection } from "./McpTokensSection";
import {
  WorkspaceSettingsForm,
  type WorkspaceSettingsValues,
} from "./WorkspaceSettingsForm";

interface ApiWorkspace {
  name: string;
}

interface MeLite {
  ai_learning_opt_out?: boolean;
}

export interface WorkspaceSettingsContainerProps {
  readonly workspaceId: string;
  readonly client?: ApiClient;
  /** 削除成功後の遷移 (現在 WS の解除は呼び出し側で)。 */
  readonly onDeleted?: () => void;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function WorkspaceSettingsContainer({
  workspaceId,
  client: injected,
  onDeleted,
}: WorkspaceSettingsContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const KEY = ["workspace", workspaceId] as const;

  const me = useQuery({
    queryKey: ["me", "ai-learning"],
    queryFn: async () => {
      const res = await client.get("/me");
      return (res as { data?: MeLite }).data ?? {};
    },
    retry: false,
  });

  const deleteMut = useMutation({
    mutationFn: () =>
      client.delete("/workspaces/{workspace_id}", {
        params: { path: { workspace_id: workspaceId } },
      }),
    onSuccess: () => onDeleted?.(),
    onError: (error) =>
      setServerError(
        error instanceof ApiError && error.status === 403
          ? "ワークスペースを削除できるのはオーナーのみです。"
          : "削除に失敗しました。",
      ),
  });

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
        body: { opt_out: !v.aiLearningOptIn },
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
  if (ws.isLoading || !ws.data || me.isLoading) {
    return <Loading className="py-md" />;
  }

  // AI 学習は GET /me の実値で初期化 (常に OFF 表示だった S-B03 と同型の実バグを是正)。
  // 取得失敗時は安全側 (OFF = opt-out) に倒す。
  const initial: WorkspaceSettingsValues = {
    name: ws.data.name,
    aiLearningOptIn: me.data ? me.data.ai_learning_opt_out === false : false,
  };

  return (
    <WorkspaceSettingsForm
      defaultValues={initial}
      onSubmit={onSubmit}
      serverError={serverError}
      onDelete={() => deleteMut.mutate()}
      membersSlot={<MembersSection workspaceId={workspaceId} client={client} />}
      tokensSlot={<McpTokensSection workspaceId={workspaceId} client={client} />}
    />
  );
}
