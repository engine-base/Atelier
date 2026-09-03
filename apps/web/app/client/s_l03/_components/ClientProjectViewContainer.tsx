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
  getClientOutputContentUrl as defaultGetContentUrl,
  patchClientComment as defaultPatchComment,
  deleteClientComment as defaultDeleteComment,
  type ClientContentUrlData,
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
  /** GAP-268: 共有済み成果物を開く (署名付き URL を取って別タブで開く)。 */
  readonly fetchContentUrl?: (
    projectId: string,
    outputId: string,
    format: "html" | "json" | "md",
    token: string,
  ) => Promise<ClientContentUrlData>;
  readonly openUrl?: (url: string) => void;
  /** GAP-267: 自分のコメントの修正・取り消し。 */
  readonly patchComment?: (
    projectId: string,
    token: string,
    commentId: string,
    content: string,
  ) => Promise<ClientCommentItemData>;
  readonly deleteComment?: (
    projectId: string,
    token: string,
    commentId: string,
  ) => Promise<void>;
  readonly confirmDelete?: (message: string) => boolean;
}

function defaultConfirmDelete(message: string): boolean {
  return window.confirm(message);
}

function defaultOpenUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
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
  fetchContentUrl = defaultGetContentUrl,
  openUrl = defaultOpenUrl,
  patchComment = defaultPatchComment,
  deleteComment = defaultDeleteComment,
  confirmDelete = defaultConfirmDelete,
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

  // GAP-268 (通し J23-05): 成果物一覧に「開く」が無く、共有された中身を見られなかった
  const [openError, setOpenError] = React.useState<string | null>(null);
  const open = useMutation({
    mutationFn: (input: { outputId: string; format: "html" | "json" | "md" }) =>
      fetchContentUrl(projectId, input.outputId, input.format, token as string),
    // 4xx (未生成 409 / 越境 404) は再試行しても変わらない。既定の 2 回再試行を切る
    retry: false,
    onSuccess: (data) => {
      setOpenError(null);
      openUrl(data.url);
    },
    onError: (error) => {
      const status =
        error instanceof ClientPortalError ? error.status : null;
      setOpenError(
        status === 409
          ? "この形式はまだ作成されていません。"
          : status === 404
            ? "この成果物は共有されていないか、削除されています。"
            : "成果物を開けませんでした。時間をおいてもう一度お試しください。",
      );
    },
  });

  // GAP-267 (通し J23-03): 自分のコメントを直せない・取り消せない
  const invalidateComments = () =>
    queryClient.invalidateQueries({
      queryKey: ["client-project", projectId, "comments"],
    });
  const edit = useMutation({
    mutationFn: (input: { commentId: string; content: string }) =>
      patchComment(projectId, token as string, input.commentId, input.content),
    retry: false,
    onSuccess: async () => {
      setPostState({ kind: "notice", text: "コメントを修正しました。" });
      await invalidateComments();
    },
    onError: (error) => {
      const status =
        error instanceof ClientPortalError ? error.status : null;
      setPostState({
        kind: "error",
        text:
          status === 404
            ? "このコメントは見つからないか、すでに取り消されています。"
            : status === 403
              ? "コメント権限がありません。"
              : "コメントの修正に失敗しました。",
      });
    },
  });
  const remove = useMutation({
    mutationFn: (commentId: string) =>
      deleteComment(projectId, token as string, commentId),
    retry: false,
    onSuccess: async () => {
      setPostState({ kind: "notice", text: "コメントを取り消しました。" });
      await invalidateComments();
    },
    onError: (error) => {
      const status =
        error instanceof ClientPortalError ? error.status : null;
      setPostState({
        kind: "error",
        text:
          status === 404
            ? "このコメントは見つからないか、すでに取り消されています。"
            : status === 403
              ? "コメント権限がありません。"
              : "コメントの取り消しに失敗しました。",
      });
    },
  });

  const post = useMutation({
    mutationFn: (input: ClientCommentCreateInput) =>
      postComment(projectId, token as string, input),
    // 再試行すると同じコメントが二重投稿されうる。失敗は 1 回で利用者に返す
    retry: false,
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
    // GAP-252: 401 を全部「セッション切れ」にしない。招待の取り消し (再サインインでは直らない) は
    // API の detail がその理由を言うので、それを出す。detail が無いときだけ従来文言
    const detail =
      query.error instanceof ClientPortalError &&
      /[\u3040-\u30ff\u4e00-\u9fff]/.test(query.error.message)
        ? query.error.message.trim()
        : null;
    return (
      <p
        role="alert"
        className="mx-auto w-full max-w-[1100px] px-6 py-8 text-body-md text-error"
      >
        {detail ??
          "セッションの有効期限が切れました。再度サインインしてください。"}
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
      onEditComment={(commentId, content) => {
        setPostState(null);
        edit.mutate({ commentId, content });
      }}
      onDeleteComment={(commentId) => {
        if (!confirmDelete("このコメントを取り消しますか？運営側からも見えなくなります。")) return;
        setPostState(null);
        remove.mutate(commentId);
      }}
      busyCommentId={
        edit.isPending
          ? edit.variables?.commentId ?? null
          : remove.isPending
            ? remove.variables ?? null
            : null
      }
      onOpenOutput={(outputId, format) => {
        setOpenError(null);
        open.mutate({ outputId, format });
      }}
      openingOutputId={open.isPending ? open.variables?.outputId ?? null : null}
      openError={openError}
      postNotice={postState?.kind === "notice" ? postState.text : null}
      postError={postState?.kind === "error" ? postState.text : null}
      onSignOut={() => {
        clearClientAccessToken();
        router.push("/portal/signin");
      }}
    />
  );
}
