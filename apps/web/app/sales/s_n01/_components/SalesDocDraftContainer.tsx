/**
 * S-N01 商談ドラフト コンテナ — T-UC-24 (design-audit v2: 実 sales-docs API 全配線)
 *
 * - GET /sales-docs?project_id&doc_type で保存済みドキュメントを一覧 (提案/見積タブ)
 * - POST /sales-docs で新規ドラフト作成 (doc_type はタブに追従)
 * - PATCH /sales-docs/{id} で本文 (summary) 編集
 * - DELETE /sales-docs/{id} で論理削除 (UI は 2 段階確認)
 * AI 文面生成はスキル/チャット側の責務。本画面はドキュメントの作成・保管・編集を担う。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import {
  SalesDocDraft,
  type DocType,
  type SalesDocRow,
  type SalesDraftValues,
} from "./SalesDocDraft";

interface ApiSalesDoc {
  id: string;
  doc_type: string;
  summary?: string | null;
  version: number;
  created_at: string;
}

export interface SalesDocDraftContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function toRow(d: ApiSalesDoc): SalesDocRow {
  return {
    id: d.id,
    docType: (d.doc_type === "estimate" ? "estimate" : "proposal") as DocType,
    summary: d.summary ?? "",
    version: d.version,
    createdAt: d.created_at,
  };
}

export function SalesDocDraftContainer({
  projectId,
  client: injected,
}: SalesDocDraftContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [docType, setDocType] = useState<DocType>("proposal");

  const listOf = (type: DocType) => ({
    queryKey: ["sales-docs", projectId, type] as const,
    queryFn: async () => {
      const res = await client.get("/sales-docs", {
        params: { query: { project_id: projectId, doc_type: type } },
      });
      const rows = (res as { data?: ApiSalesDoc[] }).data ?? [];
      return rows.map(toRow);
    },
    retry: false,
  });

  const proposals = useQuery(listOf("proposal"));
  const estimates = useQuery(listOf("estimate"));
  const active = docType === "proposal" ? proposals : estimates;

  const invalidate = (): void =>
    void queryClient.invalidateQueries({ queryKey: ["sales-docs", projectId] });

  const createMut = useMutation({
    mutationFn: async (v: SalesDraftValues) => {
      const summary = `# ${v.opportunity}\n\n顧客: ${v.customer}\n\n${v.summary}`;
      const res = await client.post("/sales-docs", {
        body: { project_id: projectId, doc_type: docType, summary },
      });
      const doc = (res as { data?: ApiSalesDoc }).data;
      if (!doc) throw new Error("ドラフトの保存に失敗しました。");
      return toRow(doc);
    },
    onSuccess: invalidate,
  });

  const editMut = useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      await client.patch("/sales-docs/{doc_id}", {
        params: { path: { doc_id: id } },
        body: { summary: content },
      });
    },
    onSuccess: invalidate,
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/sales-docs/{doc_id}", {
        params: { path: { doc_id: id } },
      }),
    onSuccess: invalidate,
  });

  return (
    <SalesDocDraft
      docType={docType}
      onDocTypeChange={setDocType}
      docs={active.data ?? []}
      docsLoading={active.isLoading}
      docsError={active.isError}
      counts={{
        proposal: proposals.data?.length ?? 0,
        estimate: estimates.data?.length ?? 0,
      }}
      onDraft={(v) => createMut.mutateAsync(v)}
      onEdit={(id, content) => editMut.mutateAsync({ id, content })}
      onDelete={(id) => deleteMut.mutate(id)}
      chatHref={`/chat?project=${projectId}`}
    />
  );
}
