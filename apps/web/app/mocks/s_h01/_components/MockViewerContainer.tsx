/**
 * S-H01 モックビューア コンテナ — T-UC-13 (実 mocks / comments API 配線)
 *
 * GET /mocks/{id}（メタ: screen_name / version / project_id）、
 * GET /mocks/{id}/content-url（署名付き閲覧 URL）、
 * GET /mocks/{id}/versions（バージョンチェーン）、
 * GET /comments (target_type=mock) を取得し MockViewer に渡す。
 * コメント追加は POST /comments（楽観追加 + 失敗ロールバック）、
 * 解決は PATCH /comments/{id} status=resolved。
 * 「編集」は POST /mocks/{id}/revise = ワンダ (AI デザイナー) への修正依頼
 * (GAP-024 / Open Design パターン) — 成功で新バージョンへ遷移。
 * バージョン操作は POST /mocks/{id}/duplicate・/discard (唯一版 409 は honest 表示)。
 * storage 未設定 (content-url 503) はメタ系 API が生きているため全面エラーにせず、
 * frame 領域のみ honest メッセージにしてバージョン/コメントは操作可能に保つ。
 * api client は注入可能。
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
  MockViewer,
  type MockCommentItem,
  type MockVersionItem,
} from "./MockViewer";

interface ApiMock {
  id: string;
  project_id: string;
  screen_name: string;
  version: number;
  meta_tags?: Record<string, unknown> | null;
  created_at?: string;
}

interface ApiComment {
  id: string;
  author_user_id?: string | null;
  author_invitation_id?: string | null;
  content: string;
  status?: string;
  parent_comment_id?: string | null;
  created_at?: string;
}

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

/** ISO → "YYYY-MM-DD HH:mm" (鉄則: 生 ISO を画面に出さない)。 */
function dateLabel(iso: string | undefined): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "";
}

export interface MockViewerContainerProps {
  readonly mockId: string;
  readonly client?: ApiClient;
}

export function MockViewerContainer({
  mockId,
  client: injected,
}: MockViewerContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const router = useRouter();
  const COMMENTS_KEY = ["mock", mockId, "comments"] as const;
  // バージョン操作 (revise / duplicate / discard) の結果通知
  const [action, setAction] = useState<{
    kind: "notice" | "error";
    text: string;
  } | null>(null);

  const meta = useQuery({
    queryKey: ["mock", mockId],
    queryFn: async () => {
      const res = await client.get("/mocks/{mock_id}", {
        params: { path: { mock_id: mockId } },
      });
      return (res as { data?: ApiMock }).data ?? null;
    },
    retry: false,
  });

  const content = useQuery({
    queryKey: ["mock", mockId, "content-url"],
    queryFn: async () => {
      const res = await client.get("/mocks/{mock_id}/content-url", {
        params: { path: { mock_id: mockId } },
      });
      return (res as { data?: { url: string } }).data ?? null;
    },
    retry: false,
  });

  const versions = useQuery({
    queryKey: ["mock", mockId, "versions"],
    queryFn: async () => {
      const res = await client.get("/mocks/{mock_id}/versions", {
        params: { path: { mock_id: mockId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiMock[]) : [];
    },
    retry: false,
  });

  const comments = useQuery({
    queryKey: COMMENTS_KEY,
    queryFn: async () => {
      const res = await client.get("/comments", {
        params: { query: { target_type: "mock", target_id: mockId } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiComment[]) : [];
    },
    retry: false,
  });

  // コメントを解決済みにする (PATCH status=resolved)。
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
    mutationFn: (text: string) =>
      client.post("/comments", {
        body: { target_type: "mock", target_id: mockId, content: text },
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

  // 「編集」= ワンダ (AI) への修正依頼 → 新バージョン生成 (GAP-024)。
  const reviseMut = useMutation({
    mutationFn: async (instruction: string) => {
      const res = await client.post("/mocks/{mock_id}/revise", {
        params: { path: { mock_id: mockId } },
        body: { instruction },
      });
      return (res as { data?: ApiMock }).data ?? null;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["mock"] });
      if (created) {
        setAction({
          kind: "notice",
          text: `ワンダが v${created.version} を作成しました。`,
        });
        router.push(`/mocks?mock=${created.id}`);
      }
    },
    onError: (e) => {
      const s = statusOf(e);
      setAction({
        kind: "error",
        text:
          s === 503
            ? "AI デザイナー（ワンダ）または保存先が未設定のため、修正を実行できません。"
            : s === 413
              ? "モック HTML が大きすぎるため自動改訂できません。画面の分割を検討してください。"
              : "修正依頼に失敗しました。時間をおいて再度お試しください。",
      });
    },
  });

  // バージョン複製 (「…」メニュー相当)。
  const duplicateMut = useMutation({
    mutationFn: async (versionId: string) => {
      const res = await client.post("/mocks/{mock_id}/duplicate", {
        params: { path: { mock_id: versionId } },
      });
      return (res as { data?: ApiMock }).data ?? null;
    },
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ["mock"] });
      setAction({
        kind: "notice",
        text: created
          ? `複製から v${created.version} を作成しました。`
          : "バージョンを複製しました。",
      });
    },
    onError: () =>
      setAction({ kind: "error", text: "バージョンの複製に失敗しました。" }),
  });

  // バージョン破棄 (唯一の生存バージョンは API が 409 で拒否)。
  const discardMut = useMutation({
    mutationFn: async (versionId: string) => {
      await client.post("/mocks/{mock_id}/discard", {
        params: { path: { mock_id: versionId } },
      });
      return versionId;
    },
    onSuccess: (versionId) => {
      void queryClient.invalidateQueries({ queryKey: ["mock"] });
      setAction({ kind: "notice", text: "バージョンを破棄しました。" });
      if (versionId === mockId) {
        // 表示中バージョンを破棄した場合は残存する最新バージョンへ移動
        const rest = (versions.data ?? []).filter((v) => v.id !== versionId);
        if (rest.length > 0) {
          const latest = rest.reduce((a, b) => (a.version >= b.version ? a : b));
          router.push(`/mocks?mock=${latest.id}`);
        }
      }
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 409
            ? "唯一のバージョンは破棄できません。"
            : "バージョンの破棄に失敗しました。",
      }),
  });

  if (statusOf(meta.error) === 403 || statusOf(content.error) === 403) {
    return (
      <p
        role="alert"
        className="rounded-md border-l-[3px] border-error bg-error/10 px-md py-sm text-body-md text-error"
      >
        このモックを表示する権限がありません。
      </p>
    );
  }
  if (meta.error) {
    return (
      <p
        role="alert"
        className="rounded-md border-l-[3px] border-error bg-error/10 px-md py-sm text-body-md text-error"
      >
        モックの取得に失敗しました。
      </p>
    );
  }
  if (meta.isLoading || content.isLoading) {
    return <Loading className="py-md" />;
  }

  // storage 未設定 (503) / 取得失敗は frame 領域のみのフォールバックに落とす。
  const src = content.data?.url ?? null;
  const srcError =
    statusOf(content.error) === 503
      ? "モックの保存先が未設定のため表示できません。"
      : content.error
        ? "モック本体の取得に失敗しました。"
        : undefined;

  const versionRows = versions.data ?? [];
  const maxVersion = versionRows.length
    ? Math.max(...versionRows.map((v) => v.version))
    : (meta.data?.version ?? 1);
  const versionItems: MockVersionItem[] = [...versionRows]
    .sort((a, b) => b.version - a.version)
    .map((v) => {
      const meta = v.meta_tags ?? {};
      const duplicatedFrom = meta.duplicated_from_version;
      return {
        id: v.id,
        version: v.version,
        createdAt: dateLabel(v.created_at),
        // ワンダ (AI デザイナー) が改訂したバージョンは author を明示 (GAP-024)
        author: meta.author === "wanda" ? "ワンダ（更新）" : undefined,
        instruction:
          typeof meta.revision_instruction === "string"
            ? meta.revision_instruction
            : undefined,
        note:
          typeof meta.note === "string"
            ? meta.note
            : typeof duplicatedFrom === "number"
              ? `v${duplicatedFrom} の複製`
              : undefined,
        href: `/mocks?mock=${v.id}`,
        current: v.id === mockId,
      };
    });

  const authorLabel = (c: ApiComment): string => {
    if (c.author_invitation_id) return "クライアント（招待）";
    if (c.author_user_id) return `メンバー ${c.author_user_id.slice(0, 8)}`;
    return "匿名";
  };
  const commentItems: MockCommentItem[] = (comments.data ?? []).map((c) => ({
    id: c.id,
    author: c.author_user_id === "あなた" ? "あなた" : authorLabel(c),
    content: c.content,
    createdAt: dateLabel(c.created_at),
    resolved: c.status === "resolved",
    isReply: Boolean(c.parent_comment_id),
  }));

  const currentVersion = meta.data?.version ?? 1;
  const versionLabel =
    currentVersion >= maxVersion
      ? `v${currentVersion} · 最新`
      : `v${currentVersion}`;

  return (
    <MockViewer
      key={mockId}
      src={src}
      srcError={srcError}
      title={meta.data?.screen_name ?? "モック"}
      versionLabel={versionLabel}
      chatHref={
        meta.data?.project_id ? `/chat?project=${meta.data.project_id}` : undefined
      }
      versions={versions.error ? undefined : versionItems}
      comments={comments.error ? undefined : commentItems}
      onAddComment={(text) => addMut.mutate(text)}
      onResolve={(id) => resolveMut.mutate(id)}
      onRevise={(instruction) => reviseMut.mutate(instruction)}
      revising={reviseMut.isPending}
      onDuplicate={(id) => duplicateMut.mutate(id)}
      onDiscard={(id) => discardMut.mutate(id)}
      actionNotice={action?.kind === "notice" ? action.text : undefined}
      actionError={action?.kind === "error" ? action.text : undefined}
    />
  );
}
