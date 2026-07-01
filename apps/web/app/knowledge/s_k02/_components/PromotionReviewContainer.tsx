/**
 * S-K02 ナレッジ昇格レビュー コンテナ — T-UC-19 (実 knowledge API 配線)
 *
 * 本人の user-scope ナレッジ（昇格候補）を GET /knowledge?account_type=user で取得し、
 * 「昇格」で POST /knowledge/{id}/promote {target_workspace_id} を呼ぶ（user → workspace common）。
 * 「却下」は提案の dismiss（サーバ側 reject endpoint が無いためクライアント側で一覧から除外）。
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { PromotionReview, type PromotionItem } from "./PromotionReview";

interface ApiKnowledge {
  id: string;
  title: string;
  content_md: string;
  confidence_score?: number;
  source_type?: string;
  category?: string;
}

const KEY = (accountId: string) =>
  ["knowledge", "promotion-candidates", accountId] as const;

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
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

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

  const promoteMut = useMutation({
    mutationFn: (id: string) =>
      client.post("/knowledge/{knowledge_id}/promote", {
        params: { path: { knowledge_id: id } },
        body: { target_workspace_id: targetWorkspaceId },
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: KEY(accountId) }),
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

  const items: PromotionItem[] = (list.data ?? [])
    .filter((k) => !dismissed.has(k.id))
    .map((k) => ({
      id: k.id,
      title: k.title,
      confidence: k.confidence_score ?? 0,
      content: k.content_md,
      source: k.source_type ?? k.category ?? "—",
    }));

  if (items.length === 0) {
    return (
      <p className="text-body-md text-on-surface-variant">
        昇格候補はありません。
      </p>
    );
  }

  return (
    <PromotionReview
      items={items}
      onApprove={(id) => promoteMut.mutate(id)}
      onReject={(id) => setDismissed((prev) => new Set(prev).add(id))}
    />
  );
}
