/**
 * S-B03 プロジェクト設定 コンテナ — T-UC-05 (実 projects API 配線)
 *
 * GET /projects/{id} で初期値を取得し、PATCH /projects/{id} (name/description/status) で更新、
 * DELETE /projects/{id} で soft-delete → 一覧へ遷移。client_name は API 更新対象外のため表示のみ。
 * api client / 遷移は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  ProjectSettingsForm,
  type ProjectSettingsValues,
} from "./ProjectSettingsForm";

type ApiStatus = "in_progress" | "draft" | "paused" | "archived";
type Lifecycle = ProjectSettingsValues["lifecycle"];

interface ApiProject {
  name: string;
  client_name?: string | null;
  description?: string | null;
  status: ApiStatus;
}

function toLifecycle(status: ApiStatus): Lifecycle {
  if (status === "paused") return "paused";
  if (status === "archived") return "archived";
  return "active";
}

function toStatus(lifecycle: Lifecycle): ApiStatus {
  if (lifecycle === "paused") return "paused";
  if (lifecycle === "archived") return "archived";
  return "in_progress";
}

export interface ProjectSettingsContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
  /** 削除成功後の遷移 (省略時は projects 一覧へ)。 */
  readonly onDeleted?: () => void;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function ProjectSettingsContainer({
  projectId,
  client: injected,
  onDeleted,
}: ProjectSettingsContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

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

  const updateMut = useMutation({
    mutationFn: (v: ProjectSettingsValues) =>
      client.patch("/projects/{project_id}", {
        params: { path: { project_id: projectId } },
        body: {
          name: v.name,
          description: v.description ?? "",
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
    lifecycle: toLifecycle(p.status),
  };

  return (
    <ProjectSettingsForm
      defaultValues={defaultValues}
      serverError={serverError}
      onSubmit={(v) => updateMut.mutate(v)}
      onDelete={() => deleteMut.mutate()}
    />
  );
}
