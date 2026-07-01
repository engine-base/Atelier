/**
 * S-G01 成果物ビューア コンテナ — T-UC-12 (実 outputs / comments API 配線)
 *
 * GET /outputs/{id}（タイトル）+ /content-url（署名付き閲覧 URL）+ GET /comments
 * (target_type=workflow_output) を取得し OutputViewer に渡す。コメント追加は
 * POST /comments（楽観追加 + 失敗ロールバック）。HTML 未生成(409) / storage 未設定(503)
 * はその旨を表示。api client は注入可能。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { Loading } from "../../../../components/Loading";
import { OutputViewer, type OutputComment } from "./OutputViewer";

interface ApiOutput {
  summary?: string | null;
  stage?: string;
}
interface ApiComment {
  id: string;
  author_user_id?: string | null;
  content: string;
  created_at?: string;
}

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export interface OutputViewerContainerProps {
  readonly outputId: string;
  readonly client?: ApiClient;
}

export function OutputViewerContainer({
  outputId,
  client: injected,
}: OutputViewerContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const COMMENTS_KEY = ["output", outputId, "comments"] as const;

  const meta = useQuery({
    queryKey: ["output", outputId],
    queryFn: async () => {
      const res = await client.get("/outputs/{output_id}", {
        params: { path: { output_id: outputId } },
      });
      return (res as { data?: ApiOutput }).data ?? null;
    },
    retry: false,
  });

  const content = useQuery({
    queryKey: ["output", outputId, "content-url"],
    queryFn: async () => {
      const res = await client.get("/outputs/{output_id}/content-url", {
        params: { path: { output_id: outputId } },
      });
      return (res as { data?: { url: string } }).data ?? null;
    },
    retry: false,
  });

  const comments = useQuery({
    queryKey: COMMENTS_KEY,
    queryFn: async () => {
      const res = await client.get("/comments", {
        params: {
          query: { target_type: "workflow_output", target_id: outputId },
        },
      });
      return (res as { data?: ApiComment[] }).data ?? [];
    },
    retry: false,
  });

  // コメント追加: 楽観的に一覧へ差し込み、失敗時に元へ戻す。
  const addMut = useMutation({
    mutationFn: (text: string) =>
      client.post("/comments", {
        body: {
          target_type: "workflow_output",
          target_id: outputId,
          content: text,
        },
      }),
    onMutate: async (text) => {
      await queryClient.cancelQueries({ queryKey: COMMENTS_KEY });
      const prev = queryClient.getQueryData<ApiComment[]>(COMMENTS_KEY);
      const optimistic: ApiComment = {
        id: `optimistic-${prev?.length ?? 0}`,
        author_user_id: "あなた",
        content: text,
        created_at: new Date().toISOString(),
      };
      queryClient.setQueryData<ApiComment[]>(COMMENTS_KEY, (old) => [
        ...(old ?? []),
        optimistic,
      ]);
      return { prev };
    },
    onError: (_e, _text, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(COMMENTS_KEY, ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY }),
  });

  if (statusOf(meta.error) === 403 || statusOf(content.error) === 403) {
    return (
      <p role="alert" className="text-body-md text-error">
        この成果物を表示する権限がありません。
      </p>
    );
  }
  if (statusOf(content.error) === 409) {
    return (
      <p role="alert" className="text-body-md text-error">
        この成果物はまだ生成されていません。
      </p>
    );
  }
  if (statusOf(content.error) === 503) {
    return (
      <p role="alert" className="text-body-md text-error">
        成果物の保存先が未設定のため表示できません。
      </p>
    );
  }
  if (meta.error || content.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        成果物の取得に失敗しました。
      </p>
    );
  }
  if (meta.isLoading || content.isLoading || !content.data) {
    return <Loading className="py-md" />;
  }

  const title = meta.data?.summary || meta.data?.stage || "成果物";
  const outputComments: OutputComment[] = (comments.data ?? []).map((c) => ({
    id: c.id,
    author: c.author_user_id ?? "匿名",
    content: c.content,
    createdAt: c.created_at ? c.created_at.slice(0, 16).replace("T", " ") : "",
  }));

  return (
    <OutputViewer
      title={title}
      contentUrl={content.data.url}
      comments={outputComments}
      onAddComment={(text) => addMut.mutate(text)}
    />
  );
}
