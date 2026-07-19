/**
 * S-K02 ナレッジ昇格レビュー コンテナ — T-UC-19 (実 knowledge API 配線) v2
 *
 * 本人の user-scope ナレッジ（昇格候補）を GET /knowledge?account_type=user で取得し、
 *   - 採用して書込: (編集があれば PATCH /knowledge/{id} →) POST /knowledge/{id}/promote
 *   - 却下: DELETE /knowledge/{id} (論理削除。以前は client 側 dismiss のみで
 *     リロードすると復活する偽装だった)
 * employee_specific は promote API 制約で昇格不可のため promotable=false で渡す。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  PromotionReview,
  type PromotionDraft,
  type PromotionItem,
} from "./PromotionReview";

interface ApiKnowledge {
  id: string;
  title: string;
  content_md: string;
  confidence_score?: number;
  source_type?: string;
  category?: string;
  scope?: string;
  tags?: readonly string[];
  created_at?: string;
}

const KEY = (accountId: string) =>
  ["knowledge", "promotion-candidates", accountId] as const;

const SOURCE_LABEL: Record<string, string> = {
  manual: "手動登録",
  ai_extracted: "AI 自動抽出",
  import: "インポート",
  mem0: "会話メモリ",
};

export interface PromotionReviewContainerProps {
  readonly accountId: string;
  readonly targetWorkspaceId: string;
  readonly client?: ApiClient;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function PromotionReviewContainer({
  accountId,
  targetWorkspaceId,
  client: injected,
}: PromotionReviewContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: KEY(accountId),
    queryFn: async () => {
      const res = await client.get("/knowledge", {
        params: { query: { account_type: "user", account_id: accountId } },
      });
      return (res as { data?: ApiKnowledge[] }).data ?? [];
    },
    retry: false,
  });

  const invalidate = (): void =>
    void queryClient.invalidateQueries({ queryKey: KEY(accountId) });

  const approveMut = useMutation({
    mutationFn: async (vars: { id: string; draft?: PromotionDraft }) => {
      if (vars.draft) {
        await client.patch("/knowledge/{knowledge_id}", {
          params: { path: { knowledge_id: vars.id } },
          body: {
            title: vars.draft.title,
            content_md: vars.draft.content_md,
            tags: [...vars.draft.tags],
            category: vars.draft.category,
          },
        });
      }
      return client.post("/knowledge/{knowledge_id}/promote", {
        params: { path: { knowledge_id: vars.id } },
        body: { target_workspace_id: targetWorkspaceId },
      });
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: () =>
      setError("昇格に失敗しました。時間をおいて再試行してください。"),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/knowledge/{knowledge_id}", {
        params: { path: { knowledge_id: id } },
      }),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: () =>
      setError("却下に失敗しました。時間をおいて再試行してください。"),
  });

  if (isForbidden(list.error)) {
    return (
      <p role="alert" className="text-body-md text-error">
        昇格候補にアクセスする権限がありません。
      </p>
    );
  }
  if (list.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        昇格候補の取得に失敗しました。
      </p>
    );
  }
  if (list.isLoading) {
    return <Loading className="py-md" />;
  }

  const rows = list.data ?? [];
  const items: PromotionItem[] = rows.map((k) => ({
    id: k.id,
    title: k.title,
    confidence: k.confidence_score ?? 0,
    content: k.content_md,
    source: SOURCE_LABEL[k.source_type ?? ""] ?? (k.source_type || "—"),
    ...(k.category ? { category: k.category } : {}),
    ...(k.tags ? { tags: k.tags } : {}),
    ...(k.created_at ? { createdAt: k.created_at } : {}),
    promotable: k.scope !== "employee_specific",
  }));

  if (items.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        昇格候補はありません。
      </p>
    );
  }

  const categories = [
    ...new Set(rows.map((k) => k.category).filter((c): c is string => Boolean(c))),
  ];

  return (
    <>
      {error ? (
        <p role="alert" className="mb-3 text-body-sm text-error">
          {error}
        </p>
      ) : null}
      <PromotionReview
        items={items}
        categories={categories}
        busy={approveMut.isPending || rejectMut.isPending}
        onApprove={(id, draft) => approveMut.mutate({ id, ...(draft ? { draft } : {}) })}
        onReject={(id) => rejectMut.mutate(id)}
      />
    </>
  );
}
