/**
 * S-L03 クライアントプロジェクトビュー コンテナ — T-UC-22 (R-T08) / GAP-029
 *
 * client_portal JWT (atelier_client_access cookie) で GET /client/projects/{id} +
 * 実コンテンツ (overview / outputs / mocks / comments) を取得し ClientProjectView
 * に渡す。コメント投稿は comment スコープ保有時のみ配線 (POST /comments)。
 * トークン未保有→サインイン誘導、403(越境)→拒否、404→不明。
 * token 取得 / fetch はテスト用に注入可能。コンテンツ系の個別失敗は
 * null (honest な取得失敗表示) に落とし、本体ビューは維持する。
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loading } from "../../../../components/Loading";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ClientProjectView,
  type ClientProjectViewData,
} from "./ClientProjectView";
import {
  clearClientAccessToken,
  getClientComments as defaultGetComments,
  getClientMocks as defaultGetMocks,
  getClientOutputs as defaultGetOutputs,
  getClientOverview as defaultGetOverview,
  getClientProject as defaultGetClientProject,
  postClientComment as defaultPostComment,
  readClientAccessToken as defaultReadToken,
  ClientPortalError,
  type ClientCommentCreateInput,
  type ClientCommentItemData,
  type ClientMocksData,
  type ClientOutputItemData,
  type ClientProjectOverviewData,
} from "../../../../lib/auth/client-portal";

export interface ClientProjectViewContainerProps {
  readonly projectId: string;
  readonly getToken?: () => string | null;
  readonly fetchProject?: (
    projectId: string,
    token: string,
  ) => Promise<ClientProjectViewData>;
  readonly fetchOverview?: (
    projectId: string,
    token: string,
  ) => Promise<ClientProjectOverviewData>;
  readonly fetchOutputs?: (
    projectId: string,
    token: string,
  ) => Promise<ClientOutputItemData[]>;
  readonly fetchMocks?: (
    projectId: string,
    token: string,
  ) => Promise<ClientMocksData>;
  readonly fetchComments?: (
    projectId: string,
    token: string,
  ) => Promise<ClientCommentItemData[]>;
  readonly postComment?: (
    projectId: string,
    token: string,
    input: ClientCommentCreateInput,
  ) => Promise<ClientCommentItemData>;
}

export function ClientProjectViewContainer({
  projectId,
  getToken = defaultReadToken,
  fetchProject = defaultGetClientProject,
  fetchOverview = defaultGetOverview,
  fetchOutputs = defaultGetOutputs,
  fetchMocks = defaultGetMocks,
  fetchComments = defaultGetComments,
  postComment = defaultPostComment,
}: ClientProjectViewContainerProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const token = getToken();
  const [postState, setPostState] = React.useState<{
    kind: "notice" | "error";
    text: string;
  } | null>(null);

  const query = useQuery({
    queryKey: ["client-project", projectId],
    queryFn: () => fetchProject(projectId, token as string),
    enabled: Boolean(token),
    retry: false,
  });

  const contentEnabled = Boolean(token) && Boolean(query.data);
  const overviewQuery = useQuery({
    queryKey: ["client-project", projectId, "overview"],
    queryFn: () => fetchOverview(projectId, token as string),
    enabled: contentEnabled,
    retry: false,
  });
  const outputsQuery = useQuery({
    queryKey: ["client-project", projectId, "outputs"],
    queryFn: () => fetchOutputs(projectId, token as string),
    enabled: contentEnabled,
    retry: false,
  });
  const mocksQuery = useQuery({
    queryKey: ["client-project", projectId, "mocks"],
    queryFn: () => fetchMocks(projectId, token as string),
    enabled: contentEnabled,
    retry: false,
  });
  const commentsQuery = useQuery({
    queryKey: ["client-project", projectId, "comments"],
    queryFn: () => fetchComments(projectId, token as string),
    enabled: contentEnabled,
    retry: false,
  });

  const post = useMutation({
    mutationFn: (input: ClientCommentCreateInput) =>
      postComment(projectId, token as string, input),
    onSuccess: async () => {
      setPostState({
        kind: "notice",
        text: "コメントを投稿しました。運営側に共有されます。",
      });
      await queryClient.invalidateQueries({
        queryKey: ["client-project", projectId, "comments"],
      });
    },
    onError: (error) => {
      const status =
        error instanceof ClientPortalError ? error.status : null;
      setPostState({
        kind: "error",
        text:
          status === 403
            ? "コメント権限がありません。"
            : "コメントの投稿に失敗しました。",
      });
    },
  });

  if (!token) {
    return (
      <p
        role="alert"
        className="mx-auto w-full max-w-[1100px] px-6 py-8 text-body-md text-error"
      >
        サインインが必要です。招待リンクから再度サインインしてください。
      </p>
    );
  }

  const status =
    query.error instanceof ClientPortalError ? query.error.status : null;
  if (status === 403) {
    return (
      <p
        role="alert"
        className="mx-auto w-full max-w-[1100px] px-6 py-8 text-body-md text-error"
      >
        このプロジェクトを参照する権限がありません。
      </p>
    );
  }
  if (status === 401) {
    return (
      <p
        role="alert"
        className="mx-auto w-full max-w-[1100px] px-6 py-8 text-body-md text-error"
      >
        セッションの有効期限が切れました。再度サインインしてください。
      </p>
    );
  }
  if (status === 404) {
    return (
      <p
        role="alert"
        className="mx-auto w-full max-w-[1100px] px-6 py-8 text-body-md text-error"
      >
        プロジェクトが見つかりません。
      </p>
    );
  }
  if (query.error) {
    return (
      <p
        role="alert"
        className="mx-auto w-full max-w-[1100px] px-6 py-8 text-body-md text-error"
      >
        プロジェクトの取得に失敗しました。
      </p>
    );
  }
  if (query.isLoading || !query.data) {
    return <Loading className="mx-auto w-full max-w-[1100px] px-6 py-8" />;
  }

  const overview = overviewQuery.error
    ? null
    : overviewQuery.data && Array.isArray(overviewQuery.data.phases)
      ? overviewQuery.data
      : undefined;
  const outputs = outputsQuery.error
    ? null
    : Array.isArray(outputsQuery.data)
      ? outputsQuery.data
      : undefined;
  const mocks = mocksQuery.error
    ? null
    : mocksQuery.data && Array.isArray(mocksQuery.data.items)
      ? mocksQuery.data
      : undefined;
  const comments = commentsQuery.error
    ? null
    : Array.isArray(commentsQuery.data)
      ? commentsQuery.data
      : undefined;

  return (
    <ClientProjectView
      data={query.data}
      overview={overview}
      outputs={outputs}
      mocks={mocks}
      comments={comments}
      onPostComment={(input) => {
        setPostState(null);
        post.mutate(input);
      }}
      posting={post.isPending}
      postNotice={postState?.kind === "notice" ? postState.text : null}
      postError={postState?.kind === "error" ? postState.text : null}
      onSignOut={() => {
        clearClientAccessToken();
        router.push("/portal/signin");
      }}
    />
  );
}
