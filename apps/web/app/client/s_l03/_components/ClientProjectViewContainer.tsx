/**
 * S-L03 クライアントプロジェクトビュー コンテナ — T-UC-22 (R-T08)
 *
 * client_portal JWT (atelier_client_access cookie) で GET /client/projects/{id} を取得し
 * ClientProjectView に渡す。トークン未保有→サインイン誘導、403(越境)→拒否、404→不明。
 * token 取得 / fetch はテスト用に注入可能。
 */

"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  ClientProjectView,
  type ClientProjectViewData,
} from "./ClientProjectView";
import {
  getClientProject as defaultGetClientProject,
  readClientAccessToken as defaultReadToken,
  ClientPortalError,
} from "../../../../lib/auth/client-portal";

export interface ClientProjectViewContainerProps {
  readonly projectId: string;
  readonly getToken?: () => string | null;
  readonly fetchProject?: (
    projectId: string,
    token: string,
  ) => Promise<ClientProjectViewData>;
}

export function ClientProjectViewContainer({
  projectId,
  getToken = defaultReadToken,
  fetchProject = defaultGetClientProject,
}: ClientProjectViewContainerProps) {
  const token = getToken();

  const query = useQuery({
    queryKey: ["client-project", projectId],
    queryFn: () => fetchProject(projectId, token as string),
    enabled: Boolean(token),
    retry: false,
  });

  if (!token) {
    return (
      <p role="alert" className="text-body-md text-error">
        サインインが必要です。招待リンクから再度サインインしてください。
      </p>
    );
  }

  const status =
    query.error instanceof ClientPortalError ? query.error.status : null;
  if (status === 403) {
    return (
      <p role="alert" className="text-body-md text-error">
        このプロジェクトを参照する権限がありません。
      </p>
    );
  }
  if (status === 401) {
    return (
      <p role="alert" className="text-body-md text-error">
        セッションの有効期限が切れました。再度サインインしてください。
      </p>
    );
  }
  if (status === 404) {
    return (
      <p role="alert" className="text-body-md text-error">
        プロジェクトが見つかりません。
      </p>
    );
  }
  if (query.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        プロジェクトの取得に失敗しました。
      </p>
    );
  }
  if (query.isLoading || !query.data) {
    return <p className="text-body-md text-on-surface-variant">読み込み中…</p>;
  }

  return <ClientProjectView data={query.data} />;
}
