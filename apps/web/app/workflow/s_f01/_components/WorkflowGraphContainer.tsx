/**
 * S-F01 工程ワークフロー（司令塔）コンテナ — T-UC-10 (実 workflow API 配線)
 *
 * GET /workflow/phases?project_id で工程を取得し、順序からノード/依存エッジを構築して
 * WorkflowGraph に渡す。API 状態(completed/skipped)を UI 状態(done/blocked)へ変換。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { WorkflowGraph, type PhaseEdge, type PhaseNode } from "./WorkflowGraph";

interface ApiPhase {
  id: string;
  name: string;
  status: string;
  order_index?: number;
  order?: number;
}

function toUi(status: string): PhaseNode["status"] {
  if (status === "completed") return "done";
  if (status === "skipped") return "blocked";
  if (status === "in_progress") return "in_progress";
  return "pending";
}

export interface WorkflowGraphContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function WorkflowGraphContainer({
  projectId,
  client: injected,
}: WorkflowGraphContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const list = useQuery({
    queryKey: ["workflow-phases", projectId],
    queryFn: async () => {
      const res = await client.get("/workflow/phases", {
        params: { query: { project_id: projectId } },
      });
      return (res as { data?: ApiPhase[] }).data ?? [];
    },
    retry: false,
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
    return <p className="text-body-md text-on-surface-variant">読み込み中…</p>;
  }

  const phases = [...(list.data ?? [])].sort(
    (a, b) => (a.order_index ?? a.order ?? 0) - (b.order_index ?? b.order ?? 0),
  );

  if (phases.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        工程がまだ登録されていません。
      </p>
    );
  }

  const nodes: PhaseNode[] = phases.map((p) => ({
    id: p.id,
    label: p.name,
    status: toUi(p.status),
  }));
  const edges: PhaseEdge[] = phases
    .slice(1)
    .map((p, i) => ({ from: phases[i]!.id, to: p.id }));

  return <WorkflowGraph nodes={nodes} edges={edges} />;
}
