/**
 * S-N01 商談ドラフト コンテナ — T-UC-24 (実 sales-docs API 配線)
 *
 * フォーム送信で POST /sales-docs (doc_type=proposal) に商談ドキュメントを作成し、
 * 入力内容のエコー + 保存確認を SalesDocDraft の生成結果として返す。
 * （AI 文面生成はスキル/チャット側の責務。本画面はドキュメント作成を担う。）
 * api client は prop 注入可能 (テスト時に fake を渡す)。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";

import { type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { SalesDocDraft, type SalesDraftValues } from "./SalesDocDraft";

export interface SalesDocDraftContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

export function SalesDocDraftContainer({
  projectId,
  client: injected,
}: SalesDocDraftContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const handleDraft = async (v: SalesDraftValues): Promise<string> => {
    const summary = `顧客: ${v.customer}\n案件: ${v.opportunity}\n\n${v.summary}`;
    const res = await client.post("/sales-docs", {
      body: { project_id: projectId, doc_type: "proposal", summary },
    });
    const id = (res as { data?: { id?: string } }).data?.id ?? "";
    return (
      `# ${v.opportunity}\n\n顧客: ${v.customer}\n\n${v.summary}\n\n---\n` +
      `商談ドキュメント（種別: 提案）として保存しました${id ? `（ID: ${id}）` : ""}。`
    );
  };

  return <SalesDocDraft onDraft={handleDraft} />;
}
