/**
 * S-B03 プロジェクト設定 コンテナ — T-UC-05 (design-audit v2: 実 projects/outputs API 全配線)
 *
 * GET /projects/{id} で初期値 (name/client_name/description/type/status/ai_learning_opt_out)、
 * PATCH /projects/{id} で name/client_name/description/type/status を更新、
 * DELETE /projects/{id} で soft-delete → 一覧へ遷移。
 * AI 学習トグルは GET の実値で初期化し POST /projects/{id}/ai-learning で即時反映。
 * エクスポートは GET /outputs?project_id&stage → GET /outputs/{id}/content-url で
 * 署名付き URL を新しいタブに開く (storage 未設定 503 は明示エラー)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  EXPORT_STAGES,
  ProjectSettingsForm,
  type ExportStage,
  type ProjectSettingsValues,
} from "./ProjectSettingsForm";

type ApiStatus = "in_progress" | "draft" | "paused" | "archived";
type Lifecycle = ProjectSettingsValues["lifecycle"];

interface ApiProject {
  name: string;
  client_name?: string | null;
  description?: string | null;
  type: ProjectSettingsValues["type"];
  status: ApiStatus;
  ai_learning_opt_out: boolean;
}

interface ApiOutput {
  id: string;
  stage: string;
}

function toLifecycle(status: ApiStatus): Lifecycle {
  if (status === "in_progress") return "active";
  return status;
}

function toStatus(lifecycle: Lifecycle): ApiStatus {
  if (lifecycle === "active") return "in_progress";
  return lifecycle;
}

export interface ProjectSettingsContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
  /** 削除成功後の遷移 (省略時は呼び出し側で指定)。 */
  readonly onDeleted?: () => void;
  /** 署名付き URL を開く (テスト時に注入可能。既定は新しいタブ)。 */
  readonly openUrl?: (url: string) => void;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function ProjectSettingsContainer({
  projectId,
  client: injected,
  onDeleted,
  openUrl,
}: ProjectSettingsContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);
  const [aiLearningOptIn, setAiLearningOptIn] = useState(false);
  const [exportingStage, setExportingStage] = useState<ExportStage | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState(false);

  const detail = useQuery({
    queryKey: ["project", "settings", projectId],
    queryFn: async () => {
      const res = await client.get("/projects/{project_id}", {
        params: { path: { project_id: projectId } },
      });
      return (res as { data?: ApiProject }).data ?? null;
    },
    retry: false,
  });

  // AI 学習トグルの初期値は GET の実値 (opt_out=true → 許可 OFF)。以降は楽観更新。
  const optOutFromApi = detail.data?.ai_learning_opt_out;
  useEffect(() => {
    if (typeof optOutFromApi === "boolean") setAiLearningOptIn(!optOutFromApi);
  }, [optOutFromApi]);

  const aiLearningMut = useMutation({
    mutationFn: (optIn: boolean) =>
      client.post("/projects/{project_id}/ai-learning", {
        params: { path: { project_id: projectId } },
        body: { opt_out: !optIn },
      }),
    onMutate: (optIn: boolean) => {
      const prev = aiLearningOptIn;
      setAiLearningOptIn(optIn); // 楽観更新
      return { prev };
    },
    onError: (_e, _optIn, ctx) => {
      if (ctx) setAiLearningOptIn(ctx.prev); // 失敗時ロールバック
      setServerError("AI 学習設定の変更に失敗しました。");
    },
    onSuccess: () => setServerError(null),
  });

  const updateMut = useMutation({
    mutationFn: (v: ProjectSettingsValues) =>
      client.patch("/projects/{project_id}", {
        params: { path: { project_id: projectId } },
        body: {
          name: v.name,
          client_name: v.client_name ?? "",
          description: v.description ?? "",
          type: v.type,
          status: toStatus(v.lifecycle),
        },
      }),
    onSuccess: () => {
      setServerError(null);
      void queryClient.invalidateQueries({
        queryKey: ["project", "settings", projectId],
      });
    },
    onError: () =>
      setServerError("保存に失敗しました。時間をおいて再試行してください。"),
  });

  const deleteMut = useMutation({
    mutationFn: () =>
      client.delete("/projects/{project_id}", {
        params: { path: { project_id: projectId } },
      }),
    onSuccess: () => onDeleted?.(),
    onError: () => setServerError("削除に失敗しました。"),
  });

  // 工程エクスポート: outputs 一覧 → 最新の成果物の署名付き URL を開く。
  const runExport = async (stage: ExportStage): Promise<void> => {
    const label = EXPORT_STAGES.find((s) => s.stage === stage)?.label ?? stage;
    setExportingStage(stage);
    setExportMessage(null);
    setExportError(false);
    try {
      const listRes = await client.get("/outputs", {
        params: { query: { project_id: projectId, stage } },
      });
      const rows = (listRes as { data?: ApiOutput[] }).data ?? [];
      const first = rows[0];
      if (!first) {
        setExportMessage(`「${label}」の成果物はまだありません。`);
        setExportError(false);
        return;
      }
      const urlRes = await client.get("/outputs/{output_id}/content-url", {
        params: { path: { output_id: first.id } },
      });
      const url = (urlRes as { data?: { url: string } }).data?.url;
      if (!url) throw new Error("no url");
      (openUrl ?? ((u: string) => window.open(u, "_blank", "noopener")))(url);
      setExportMessage(`「${label}」の成果物を開きました。`);
      setExportError(false);
    } catch (e) {
      setExportError(true);
      if (e instanceof ApiError && e.status === 503) {
        setExportMessage(
          "エクスポートに失敗しました（storage が未設定です。管理者に確認してください）。",
        );
      } else if (e instanceof ApiError && e.status === 409) {
        setExportMessage(
          `「${label}」の成果物はまだ HTML 化されていません。`,
        );
      } else {
        setExportMessage("エクスポートに失敗しました。");
      }
    } finally {
      setExportingStage(null);
    }
  };

  if (isForbidden(detail.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        このプロジェクトを編集する権限がありません。
      </p>
    );
  }
  if (detail.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        プロジェクトの取得に失敗しました。
      </p>
    );
  }
  if (detail.isLoading || !detail.data) {
    return <Loading className="py-md" />;
  }

  const p = detail.data;
  const defaultValues: ProjectSettingsValues = {
    name: p.name,
    client_name: p.client_name ?? "",
    description: p.description ?? "",
    type: p.type ?? "personal",
    lifecycle: toLifecycle(p.status),
  };

  return (
    <ProjectSettingsForm
      defaultValues={defaultValues}
      serverError={serverError}
      onSubmit={(v) => updateMut.mutate(v)}
      onDelete={() => deleteMut.mutate()}
      aiLearningOptIn={aiLearningOptIn}
      onAiLearningChange={(optIn) => aiLearningMut.mutate(optIn)}
      inviteHref={`/portal/invitations?project=${projectId}`}
      onExport={(stage) => void runExport(stage)}
      exportingStage={exportingStage}
      exportMessage={exportMessage}
      exportError={exportError}
    />
  );
}
