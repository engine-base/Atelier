/**
 * S-N01 商談ドラフト コンテナ — T-UC-24 / GAP-018 (実 sales-docs API 全配線)
 *
 * - GET /sales-docs?project_id で全 doc_type を一覧 (5 タブの件数バッジ実データ)
 * - POST /sales-docs/generate = 営業 AI トニーへの生成依頼 (ナレッジ RAG +
 *   生成トレース。LLM 未設定は 503 → honest エラー)
 * - POST /sales-docs = AI を使わない構造化保存 (LLM 未設定環境の導線)
 * - PATCH /sales-docs/{id} 本文編集 / DELETE 論理削除 (2 段階確認)
 * - GET /sales-docs/{id}/pdf = 実 PDF DL (blob) / POST .../send = メール送信
 *   (dry_run は正直に表示) / GET .../sends = 送信履歴
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import {
  API_BASE,
  createAuthedApiClient,
  readAccessToken,
} from "../../../../lib/auth/connector";
import {
  DOC_TYPE_LABEL,
  SalesDocDraft,
  type DocType,
  type SalesDocRow,
  type SalesDraftValues,
  type SalesKnowledgeRef,
  type SalesSendRow,
} from "./SalesDocDraft";

interface ApiSalesDoc {
  id: string;
  doc_type: string;
  summary?: string | null;
  version: number;
  created_at: string;
  meta?: Record<string, unknown> | null;
}

interface ApiSend {
  id: string;
  to_email: string;
  subject: string;
  dry_run: boolean;
  created_at: string;
}

const DOC_TYPES: readonly DocType[] = [
  "proposal",
  "estimate",
  "contract",
  "nda",
  "invoice",
];

export interface SalesDocDraftContainerProps {
  readonly projectId: string;
  readonly client?: ApiClient;
}

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

function toRow(d: ApiSalesDoc): SalesDocRow {
  const meta = d.meta ?? {};
  const refs = Array.isArray(meta.knowledge_refs)
    ? (meta.knowledge_refs as SalesKnowledgeRef[])
    : undefined;
  const steps = Array.isArray(meta.steps)
    ? (meta.steps as string[])
    : undefined;
  return {
    id: d.id,
    docType: (DOC_TYPES as readonly string[]).includes(d.doc_type)
      ? (d.doc_type as DocType)
      : "proposal",
    summary: d.summary ?? "",
    version: d.version,
    createdAt: d.created_at,
    generatedBy: typeof meta.generated_by === "string" ? meta.generated_by : undefined,
    model: typeof meta.model === "string" ? meta.model : undefined,
    knowledgeRefs: refs,
    steps,
  };
}

export function SalesDocDraftContainer({
  projectId,
  client: injected,
}: SalesDocDraftContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [docType, setDocType] = useState<DocType>("proposal");
  const [selected, setSelected] = useState<SalesDocRow | null>(null);
  const [action, setAction] = useState<{
    kind: "notice" | "error";
    text: string;
  } | null>(null);
  // GAP-171: トニーの生成も本人の Claude サブスク経由になったため、
  // 未接続 (503) はその場に接続フローを出す (GAP-168 と同じ扱い)。
  const [bridgeOffline, setBridgeOffline] = useState(false);

  // 全 doc_type を一括取得し client 側で振り分け (5 タブの件数バッジ実データ)
  const list = useQuery({
    queryKey: ["sales-docs", projectId],
    queryFn: async () => {
      const res = await client.get("/sales-docs", {
        params: { query: { project_id: projectId } },
      });
      const rows = (res as { data?: ApiSalesDoc[] }).data ?? [];
      return rows.map(toRow);
    },
    retry: false,
  });

  const sends = useQuery({
    queryKey: ["sales-doc-sends", selected?.id ?? "none"],
    enabled: !!selected,
    queryFn: async () => {
      const res = await client.get("/sales-docs/{doc_id}/sends", {
        params: { path: { doc_id: selected?.id ?? "" } },
      });
      const rows = (res as { data?: ApiSend[] }).data ?? [];
      return rows.map(
        (s): SalesSendRow => ({
          id: s.id,
          toEmail: s.to_email,
          subject: s.subject,
          dryRun: s.dry_run,
          createdAt: s.created_at,
        }),
      );
    },
    retry: false,
  });

  const invalidate = (): void =>
    void queryClient.invalidateQueries({ queryKey: ["sales-docs", projectId] });

  // AI 生成 (トニー + ナレッジ RAG — 明示操作起点)
  const generateMut = useMutation({
    mutationFn: async (v: SalesDraftValues) => {
      const res = await client.post("/sales-docs/generate", {
        body: {
          project_id: projectId,
          doc_type: docType,
          customer: v.customer,
          opportunity: v.opportunity,
          notes: v.summary,
        },
      });
      const doc = (res as { data?: ApiSalesDoc }).data;
      if (!doc) throw new Error("生成に失敗しました。");
      return toRow(doc);
    },
    onSuccess: (row) => {
      invalidate();
      const n = row.knowledgeRefs?.length ?? 0;
      setAction({
        kind: "notice",
        text: `トニーが${DOC_TYPE_LABEL[row.docType]} v${row.version} を生成しました（ナレッジ参照 ${n} 件）。`,
      });
    },
    onError: (e) => {
      setBridgeOffline(statusOf(e) === 503);
      setAction({
        kind: "error",
        text:
          statusOf(e) === 503
            ? "お使いのパソコン (Bridge) が未接続のため生成できません。「AI を使わず保存」でも進められます。"
            : "ドラフトの生成に失敗しました。",
      });
    },
  });

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
    onError: () =>
      setAction({ kind: "error", text: "ドラフトの保存に失敗しました。" }),
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

  const sendMut = useMutation({
    mutationFn: async (vars: {
      id: string;
      toEmail: string;
      subject?: string;
      message?: string;
    }) => {
      const res = await client.post("/sales-docs/{doc_id}/send", {
        params: { path: { doc_id: vars.id } },
        body: {
          to_email: vars.toEmail,
          ...(vars.subject ? { subject: vars.subject } : {}),
          ...(vars.message ? { message: vars.message } : {}),
        },
      });
      return (res as { data?: ApiSend }).data ?? null;
    },
    onSuccess: (sent) => {
      void queryClient.invalidateQueries({
        queryKey: ["sales-doc-sends", selected?.id ?? "none"],
      });
      if (sent) {
        setAction({
          kind: "notice",
          text: sent.dry_run
            ? `${sent.to_email} 宛の送信を記録しました（メール未設定のため実送信されていません — dry-run）。`
            : `${sent.to_email} へ送信しました。`,
        });
      }
    },
    onError: (e) =>
      setAction({
        kind: "error",
        text:
          statusOf(e) === 422
            ? "メールアドレスの形式が不正です。"
            : "送信に失敗しました。",
      }),
  });

  // PDF: 実バイナリを blob DL (失敗時は honest エラー — 偽 DL しない)
  const downloadPdf = async (id: string): Promise<void> => {
    try {
      const token = readAccessToken();
      const res = await fetch(`${API_BASE}/sales-docs/${id}/pdf`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!res.ok) throw new Error(`pdf failed: ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sales-doc-${id.slice(0, 8)}.pdf`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      setAction({
        kind: "error",
        text: "PDF の生成に失敗しました。本文が空の可能性があります。",
      });
    }
  };

  const all = list.data ?? [];
  const counts = Object.fromEntries(
    DOC_TYPES.map((t) => [t, all.filter((d) => d.docType === t).length]),
  ) as Record<DocType, number>;

  return (
    <SalesDocDraft
      docType={docType}
      onDocTypeChange={setDocType}
      docs={all.filter((d) => d.docType === docType)}
      docsLoading={list.isLoading}
      docsError={list.isError}
      counts={counts}
      onGenerate={(v) => generateMut.mutateAsync(v)}
      onSaveRaw={(v) => createMut.mutateAsync(v)}
      onEdit={(id, content) => editMut.mutateAsync({ id, content })}
      onDelete={(id) => deleteMut.mutate(id)}
      chatHref={`/chat?project=${projectId}`}
      selected={selected}
      onSelect={setSelected}
      onPdf={(id) => void downloadPdf(id)}
      onSend={(id, input) => sendMut.mutate({ id, ...input })}
      sending={sendMut.isPending}
      sends={sends.data}
      sendsLoading={!!selected && sends.isLoading}
      actionNotice={action?.kind === "notice" ? action.text : undefined}
      actionError={action?.kind === "error" ? action.text : undefined}
      bridgeOffline={bridgeOffline}
    />
  );
}
