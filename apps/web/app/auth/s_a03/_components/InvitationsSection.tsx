/**
 * S-A03 招待管理タブ (GAP-116 追補 — 経営者指示)
 *
 * これまで「招待管理」タブは /portal/invitations への遷移で、WS 設定の
 * タブ文脈が失われていた (タブが消えたように見える)。本コンポーネントは
 * S-L01 の実体 (InvitationsListContainer) をタブパネル内に埋め込み、
 * WS 内のプロジェクトを選んでその招待を管理できるようにする。
 *
 * プロジェクトが 0 件の場合は誠実に案内する (招待はプロジェクト単位のため)。
 */

"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import type { ApiClient } from "@atelier/api-client";

import { InvitationsListContainer } from "../../../client/s_l01/_components/InvitationsListContainer";

interface ProjectLite {
  readonly id: string;
  readonly name: string;
  readonly workspace_id?: string;
}

export interface InvitationsSectionProps {
  readonly workspaceId: string;
  readonly client: ApiClient;
}

export function InvitationsSection({ workspaceId, client }: InvitationsSectionProps) {
  const projects = useQuery({
    queryKey: ["ws-projects", workspaceId],
    queryFn: async () => {
      const res = await client.get("/projects");
      const rows = ((res as { data?: readonly ProjectLite[] }).data ?? []).filter(
        (p) => !p.workspace_id || p.workspace_id === workspaceId,
      );
      return rows;
    },
    retry: false,
  });
  const [selected, setSelected] = React.useState<string | null>(null);
  const projectId = selected ?? projects.data?.[0]?.id ?? null;

  if (projects.isLoading) {
    return (
      <p className="text-body-md text-on-surface-variant">プロジェクトを読み込み中…</p>
    );
  }
  if (projects.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        プロジェクトの取得に失敗しました。
      </p>
    );
  }
  if (!projects.data || projects.data.length === 0 || !projectId) {
    return (
      <p className="text-body-md text-on-surface-variant">
        クライアント招待はプロジェクト単位で発行します。先にプロジェクトを作成してください。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex w-fit items-center gap-3 text-body-md text-on-surface">
        <span className="text-label-lg font-semibold">対象プロジェクト</span>
        <select
          value={projectId}
          onChange={(e) => setSelected(e.target.value)}
          className="h-10 rounded-md border border-border bg-surface px-3 text-body-md text-on-surface focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-container"
        >
          {projects.data.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <InvitationsListContainer projectId={projectId} client={client} />
    </div>
  );
}
