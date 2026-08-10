/**
 * S-G01 成果物ビューア コンテナ — T-UC-12 / GAP-023 (実 outputs / comments API 配線)
 *
 * GET /outputs/{id}（メタ + format 別パス）+ /content-url?format（署名付き URL）
 * + /versions + /anchors + /fix-proposals + GET /comments (target_type=
 * workflow_output)。コメント追加 (target_element_id / parent_comment_id 対応)、
 * 解決、AI 修正提案 (POST /comments/{id}/fix-proposal → 承認 = 新バージョン適用 /
 * 却下 = 不変)、「編集」= POST /outputs/{id}/revise (ドキュメント AI スティーブへの
 * 修正依頼 — 成功で新バージョンへ遷移)、DL (現在 format の blob 保存)。
 * HTML 未生成(409) / storage 未設定(503) はその旨を表示。api client は注入可能。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { Loading } from "../../../../components/Loading";
import {
  OutputViewer,
  type OutputAnchorItem,
  type OutputComment,
  type OutputFixProposalItem,
  type OutputFormat,
  type OutputVersionItem,
} from "./OutputViewer";

interface ApiOutput {
  id: string;
  summary?: string | null;
  stage?: string;
  version?: number;
  html_path?: string | null;
  json_path?: string | null;
  md_path?: string | null;
  meta?: Record<string, unknown> | null;
  created_at?: string;
}
interface ApiComment {
  id: string;
  author_user_id?: string | null;
  author_invitation_id?: string | null;
  content: string;
  status?: string;
  parent_comment_id?: string | null;
  target_element_id?: string | null;
  created_at?: string;
}
interface ApiAnchor {
  element_id: string;
  label: string;
}
interface ApiProposal {
  id: string;
  comment_id: string;
  output_id: string;
  proposal: string;
  status: string;
  applied_output_id?: string | null;
}

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

/** ISO → "YYYY-MM-DD HH:mm" (鉄則: 生 ISO を画面に出さない)。 */
function dateLabel(iso: string | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
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
  const router = useRouter();
  const COMMENTS_KEY = ["output", outputId, "comments"] as const;
  const [format, setFormat] = useState<OutputFormat>("html");
  const [action, setAction] = useState<{
    kind: "notice" | "error";
    text: string;
  } | null>(null);

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

  // JSON/MD タブの実テキスト (署名 URL → fetch)。html は iframe 直表示。
  const text = useQuery({
    queryKey: ["output", outputId, "text", format],
    enabled: format !== "html",
    queryFn: async () => {
      const res = await client.get("/outputs/{output_id}/content-url", {
        params: {
          path: { output_id: outputId },
          query: { format },
        },
      });
      const url = (res as { data?: { url: string } }).data?.url;
      if (!url) return "";
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch ${format} failed: ${r.status}`);
      return await r.text();
    },
    retry: false,
  });

  const versions = useQuery({
    queryKey: ["output", outputId, "versions"],
    queryFn: async () => {
      const res = await client.get("/outputs/{output_id}/versions", {
        params: { path: { output_id: outputId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiOutput[]) : [];
    },
    retry: false,
  });

  const anchors = useQuery({
    queryKey: ["output", outputId, "anchors"],
    queryFn: async () => {
      const res = await client.get("/outputs/{output_id}/anchors", {
        params: { path: { output_id: outputId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiAnchor[]) : [];
    },
    retry: false,
  });

  const proposals = useQuery({
    queryKey: ["output", outputId, "fix-proposals"],
    queryFn: async () => {
      const res = await client.get("/outputs/{output_id}/fix-proposals", {
        params: { path: { output_id: outputId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiProposal[]) : [];
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

  const resolveMut = useMutation({
    mutationFn: (id: string) =>
      client.patch("/comments/{comment_id}", {
        params: { path: { comment_id: id } },
        body: { status: "resolved" },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY }),
  });

  // コメント追加: 楽観的に一覧へ差し込み、失敗時に元へ戻す。
  const addMut = useMutation({
    mutationFn: (input: { text: string; targetElementId?: string }) =>
      client.post("/comments", {
        body: {
          target_type: "workflow_output",
          target_id: outputId,
          content: input.text,
          ...(input.targetElementId
            ? { target_element_id: input.targetElementId }
            : {}),
        },
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: COMMENTS_KEY });
      const prev = queryClient.getQueryData<ApiComment[]>(COMMENTS_KEY);
      const optimistic: ApiComment = {
        id: `optimistic-${prev?.length ?? 0}`,
        author_user_id: "あなた",
        content: input.text,
        target_element_id: input.targetElementId ?? null,
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

  // スレッド返信 (parent_comment_id 付き)
  const replyMut = useMutation({
    mutationFn: (input: { parentId: string; text: string }) =>
      client.post("/comments", {
        body: {
          target_type: "workflow_output",
          target_id: outputId,
          content: input.text,
          parent_comment_id: input.parentId,
        },
      }),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: COMMENTS_KEY }),
  });

  // 「編集」= ドキュメント AI (スティーブ) への修正依頼 → 新バージョンへ遷移
  const reviseMut = useMutation({
    mutationFn: async (instruction: string) => {
      const res = await client.post("/outputs/{output_id}/revise", {
        params: { path: { output_id: outputId } },
        body: { instruction },
      });
      return (res as { data?: ApiOutput }).data ?? null;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["output"] });
      if (created) {
        setAction({
          kind: "notice",
          text: `スティーブが v${created.version} を作成しました。`,
        });
        router.push(`/outputs?output=${created.id}`);
      }
    },
    onError: (e) => {
      const s = statusOf(e);
      setAction({
        kind: "error",
        text:
          s === 503
            ? "ドキュメント AI（スティーブ）または保存先が未設定のため、修正を実行できません。"
            : s === 413
              ? "本文が大きすぎるため自動改訂できません。分割を検討してください。"
              : s === 409
                ? "この成果物には改訂対象の HTML がありません。"
                : "修正依頼に失敗しました。時間をおいて再度お試しください。",
      });
    },
  });

  // AI 修正提案の生成 (人間の明示操作起点 — 自動生成しない)
  const proposeMut = useMutation({
    mutationFn: (commentId: string) =>
      client.post("/comments/{comment_id}/fix-proposal", {
        params: { path: { comment_id: commentId } },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["output", outputId, "fix-proposals"],
      }),
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 503
            ? "ドキュメント AI（スティーブ）が未設定のため提案を生成できません。"
            : statusOf(e) === 409
              ? "このコメントには既に未処理の提案があります。"
              : "修正提案の生成に失敗しました。",
      }),
  });

  const approveMut = useMutation({
    mutationFn: async (proposalId: string) => {
      const res = await client.post(
        "/output-fix-proposals/{proposal_id}/approve",
        { params: { path: { proposal_id: proposalId } } },
      );
      return (
        (res as { data?: { new_output?: ApiOutput } }).data?.new_output ?? null
      );
    },
    onSuccess: (newOutput) => {
      void queryClient.invalidateQueries({ queryKey: ["output"] });
      if (newOutput) {
        setAction({
          kind: "notice",
          text: `提案を承認し、スティーブが v${newOutput.version} を作成しました。`,
        });
        router.push(`/outputs?output=${newOutput.id}`);
      }
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 409
            ? "この提案は既に処理済みです。"
            : statusOf(e) === 503
              ? "ドキュメント AI（スティーブ）または保存先が未設定のため適用できません。"
              : "提案の承認に失敗しました。",
      }),
  });

  const rejectMut = useMutation({
    mutationFn: (proposalId: string) =>
      client.post("/output-fix-proposals/{proposal_id}/reject", {
        params: { path: { proposal_id: proposalId } },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["output", outputId, "fix-proposals"],
      });
      setAction({
        kind: "notice",
        text: "提案を却下しました（文書は変更されていません）。",
      });
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 409
            ? "この提案は既に処理済みです。"
            : "提案の却下に失敗しました。",
      }),
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

  // 実在する format のみタブ化 (Rule 10: 死にタブを出さない)
  const formats: OutputFormat[] = ["html"];
  if (meta.data?.json_path) formats.push("json");
  if (meta.data?.md_path) formats.push("md");

  const versionRows = versions.data ?? [];
  const versionItems: OutputVersionItem[] = versionRows.map((v) => ({
    id: v.id,
    version: v.version ?? 1,
    createdAt: dateLabel(v.created_at),
    current: v.id === outputId,
    author:
      (v.meta as Record<string, unknown> | undefined)?.author === "steve"
        ? "スティーブ（更新）"
        : undefined,
  }));
  const versionOf = (id: string): number | undefined =>
    versionRows.find((v) => v.id === id)?.version;

  const anchorItems: OutputAnchorItem[] = (anchors.data ?? []).map((a) => ({
    elementId: a.element_id,
    label: a.label,
  }));
  const anchorLabel = (elementId: string): string =>
    anchorItems.find((a) => a.elementId === elementId)?.label ?? elementId;

  const proposalItems: OutputFixProposalItem[] = (proposals.data ?? []).map(
    (p) => ({
      id: p.id,
      commentId: p.comment_id,
      proposal: p.proposal,
      status:
        p.status === "approved"
          ? "approved"
          : p.status === "rejected"
            ? "rejected"
            : "pending",
      appliedVersionLabel: p.applied_output_id
        ? `v${versionOf(p.applied_output_id) ?? "?"}`
        : undefined,
      appliedHref: p.applied_output_id
        ? `/outputs?output=${p.applied_output_id}`
        : undefined,
    }),
  );

  const authorLabelOf = (c: ApiComment): string => {
    if (c.author_invitation_id) return "クライアント（招待）";
    if (c.author_user_id) return `メンバー ${c.author_user_id.slice(0, 8)}`;
    return "匿名";
  };
  const outputComments: OutputComment[] = (comments.data ?? []).map((c) => ({
    id: c.id,
    author: c.author_user_id === "あなた" ? "あなた" : authorLabelOf(c),
    content: c.content,
    createdAt: dateLabel(c.created_at),
    resolved: c.status === "resolved",
    isReply: Boolean(c.parent_comment_id),
    targetElementId: c.target_element_id ?? undefined,
    targetLabel: c.target_element_id
      ? anchorLabel(c.target_element_id)
      : undefined,
    // 楽観追加中は操作不可 (偽 id で API を叩かない)
    pending: c.id.startsWith("optimistic-"),
  }));

  // DL: 現在 format の実体を blob 保存 (成功時のみファイル生成 — 偽 DL しない)
  const download = async () => {
    try {
      const res = await client.get("/outputs/{output_id}/content-url", {
        params: { path: { output_id: outputId }, query: { format } },
      });
      const url = (res as { data?: { url: string } }).data?.url;
      if (!url) throw new Error("no url");
      const r = await fetch(url);
      if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${title}.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      setAction({
        kind: "error",
        text: "ダウンロードに失敗しました。該当形式が未生成の可能性があります。",
      });
    }
  };

  return (
    <OutputViewer
      key={outputId}
      title={title}
      contentUrl={content.data.url}
      formats={formats}
      activeFormat={format}
      onSelectFormat={setFormat}
      textContent={text.data}
      textLoading={format !== "html" && text.isLoading}
      versions={versions.error ? undefined : versionItems}
      onSelectVersion={(id) => {
        if (id !== outputId) router.push(`/outputs?output=${id}`);
      }}
      onDownload={() => void download()}
      onRevise={(instruction) => reviseMut.mutate(instruction)}
      revising={reviseMut.isPending}
      actionNotice={action?.kind === "notice" ? action.text : undefined}
      actionError={action?.kind === "error" ? action.text : undefined}
      comments={outputComments}
      onAddComment={(text_, targetElementId) =>
        addMut.mutate({ text: text_, targetElementId })
      }
      anchors={anchors.error ? undefined : anchorItems}
      onResolve={(id) => resolveMut.mutate(id)}
      onReply={(parentId, text_) => replyMut.mutate({ parentId, text: text_ })}
      proposals={proposals.error ? undefined : proposalItems}
      onRequestProposal={(commentId) => proposeMut.mutate(commentId)}
      proposalRequestingFor={
        proposeMut.isPending ? proposeMut.variables : undefined
      }
      onApproveProposal={(id) => approveMut.mutate(id)}
      onRejectProposal={(id) => rejectMut.mutate(id)}
      proposalResolving={approveMut.isPending ? approveMut.variables : undefined}
    />
  );
}
