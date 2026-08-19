/**
 * 出力テンプレート管理 (GAP-154) — workspace 単位・種類ごとに自作。
 *
 * 経営者決定「テンプレは workspace のみ。基本的にそれを使う」の管理画面:
 *   - 種類 (見積書/提案書/請求書/テスト仕様書 等 = workflow stage 体系) を選び、
 *     テンプレ本文 (Markdown/構成) を書いて保存
 *   - 保存済みの種類には「設定済み」バッジ — AI の成果物生成・改訂に必ず注入される
 *   - 削除で「テンプレ無し生成」に戻る (誠実 — 消したのに効き続けない)
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../lib/auth/connector";
import { readCurrentWorkspace } from "../../../lib/currentWorkspace";
import { Loading } from "../../../components/Loading";
import { cn } from "../../../lib/cn";

/** 種類 = 成果物の stage 体系 (API の STAGE_LABELS と同一)。 */
export const TEMPLATE_KINDS: readonly { key: string; label: string }[] = [
  { key: "estimate", label: "見積書" },
  { key: "proposal", label: "提案書" },
  { key: "invoice", label: "請求書" },
  { key: "contract", label: "契約書ドラフト" },
  { key: "nda", label: "NDA ドラフト" },
  { key: "hearing", label: "議事録・ヒアリングメモ" },
  { key: "requirements", label: "要件定義書" },
  { key: "architecture", label: "アーキ設計書" },
  { key: "design", label: "デザイン仕様書" },
  { key: "breakdown", label: "機能分解書" },
  { key: "tasks", label: "タスク一覧" },
  { key: "implementation", label: "実装ドキュメント" },
  { key: "verification", label: "テスト仕様書" },
  { key: "delivery", label: "納品書・完了報告" },
];

interface ApiTemplate {
  id: string;
  workspace_id: string;
  stage: string;
  stage_label: string;
  title: string;
  content_md: string;
  updated_at?: string;
}

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

export interface OutputTemplatesContainerProps {
  readonly client?: ApiClient;
  /** テスト注入用 (省略時は localStorage → /workspaces 先頭)。 */
  readonly workspaceId?: string;
}

export function OutputTemplatesContainer({
  client: injected,
  workspaceId: forcedWs,
}: OutputTemplatesContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>("estimate");
  const [draft, setDraft] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  // workspace 解決: 明示指定 → localStorage → /workspaces の先頭
  const wsQuery = useQuery({
    queryKey: ["workspaces", "for-settings"],
    enabled: !forcedWs,
    queryFn: async () => {
      const res = await client.get("/workspaces", {});
      const d = (res as { data?: { id: string; name?: string }[] }).data ?? [];
      return d;
    },
    retry: false,
  });
  const wsId =
    forcedWs ??
    (typeof window !== "undefined" ? readCurrentWorkspace() : undefined) ??
    wsQuery.data?.[0]?.id;

  const templates = useQuery({
    queryKey: ["output-templates", wsId],
    enabled: Boolean(wsId),
    queryFn: async () => {
      const res = await client.get("/workspaces/{workspace_id}/output-templates", {
        params: { path: { workspace_id: wsId ?? "" } },
      });
      const d = (res as { data?: unknown }).data;
      return Array.isArray(d) ? (d as ApiTemplate[]) : [];
    },
    retry: false,
  });

  const existing = (templates.data ?? []).find((t) => t.stage === selected);
  const content = draft ?? existing?.content_md ?? "";
  const title = titleDraft ?? existing?.title ?? "";

  const save = useMutation({
    retry: false,
    mutationFn: async () => {
      const res = await client.put(
        "/workspaces/{workspace_id}/output-templates/{stage}",
        {
          params: { path: { workspace_id: wsId ?? "", stage: selected } },
          body: { title: title.trim(), content_md: content.trim() },
        },
      );
      return (res as { data?: ApiTemplate }).data ?? null;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["output-templates", wsId] });
      setDraft(null);
      setTitleDraft(null);
      setNotice({
        kind: "ok",
        text: "保存しました。以後この種類の成果物の生成・改訂には必ずこのテンプレが使われます。",
      });
    },
    onError: () =>
      setNotice({ kind: "error", text: "テンプレートの保存に失敗しました。" }),
  });

  const remove = useMutation({
    retry: false,
    mutationFn: async () => {
      await client.delete("/workspaces/{workspace_id}/output-templates/{stage}", {
        params: { path: { workspace_id: wsId ?? "", stage: selected } },
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["output-templates", wsId] });
      setDraft(null);
      setTitleDraft(null);
      setNotice({
        kind: "ok",
        text: "削除しました。以後この種類はテンプレ無しで生成されます。",
      });
    },
    onError: (e) =>
      setNotice({
        kind: "error",
        text:
          statusOf(e) === 404
            ? "この種類のテンプレートはまだありません。"
            : "テンプレートの削除に失敗しました。",
      }),
  });

  if (!forcedWs && wsQuery.isLoading) return <Loading className="py-md" />;
  if (!wsId) {
    return (
      <p role="alert" className="text-body-md text-on-surface-variant">
        ワークスペースが見つかりません。
      </p>
    );
  }
  if (templates.isLoading) return <Loading className="py-md" />;
  if (templates.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        出力テンプレートの取得に失敗しました。
      </p>
    );
  }

  const configured = new Set((templates.data ?? []).map((t) => t.stage));
  const selectedLabel =
    TEMPLATE_KINDS.find((k) => k.key === selected)?.label ?? selected;

  return (
    <section aria-label="出力テンプレート">
      <h1 className="text-headline-md font-bold tracking-tight text-on-surface">
        ワークスペース設定
      </h1>
      <h2 className="mt-lg text-title-md font-bold text-on-surface">
        出力テンプレート
      </h2>
      <p className="mt-1 text-body-sm text-on-surface-variant">
        見積書・提案書・テスト仕様書などの「型」をワークスペース単位で自作します。
        保存した種類は、AI 社員の成果物生成・改訂の指示に<strong>必ず注入</strong>
        され、その構成・項目・書式に従って出力されます。
      </p>

      {/* 種類ピッカー (設定済みバッジつき) */}
      <div
        role="tablist"
        aria-label="テンプレートの種類"
        className="mt-md flex flex-wrap gap-1.5"
      >
        {TEMPLATE_KINDS.map((k) => (
          <button
            key={k.key}
            type="button"
            role="tab"
            aria-selected={selected === k.key}
            onClick={() => {
              setSelected(k.key);
              setDraft(null);
              setTitleDraft(null);
              setNotice(null);
            }}
            className={cn(
              "rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors",
              selected === k.key
                ? "border-primary bg-primary text-on-primary"
                : "border-border text-on-surface-variant hover:text-on-surface",
            )}
          >
            {k.label}
            {configured.has(k.key) ? (
              <span className="ml-1 text-[10px]">●設定済み</span>
            ) : null}
          </button>
        ))}
      </div>

      {/* エディタ */}
      <form
        className="mt-md rounded-lg border border-border bg-surface p-md"
        onSubmit={(e) => {
          e.preventDefault();
          if (content.trim() === "" || save.isPending) return;
          save.mutate();
        }}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-[14px] font-bold text-on-surface">
            {selectedLabel} のテンプレート
          </h3>
          {existing ? (
            <span className="inline-flex items-center rounded-sm bg-tertiary-container px-2 py-0.5 text-[10.5px] font-semibold text-tertiary-container-fg">
              設定済み — 生成時に必ず使用
            </span>
          ) : (
            <span className="inline-flex items-center rounded-sm bg-surface-variant px-2 py-0.5 text-[10.5px] font-semibold text-on-surface-variant">
              未設定 — AI の既定フォーマットで生成
            </span>
          )}
        </div>
        <label className="mt-2 block">
          <span className="text-[11.5px] font-semibold text-on-surface-variant">
            呼び名（任意）
          </span>
          <input
            value={title}
            onChange={(e) => setTitleDraft(e.target.value)}
            maxLength={120}
            placeholder="例: 標準見積フォーマット v2"
            className="mt-0.5 w-full rounded-md border border-border bg-surface px-sm py-1.5 text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant focus-visible:border-primary"
          />
        </label>
        <label className="mt-2 block">
          <span className="text-[11.5px] font-semibold text-on-surface-variant">
            テンプレ本文（構成・項目・書式 — Markdown 可）
          </span>
          <textarea
            value={content}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            maxLength={20000}
            placeholder={
              "例:\n# 御見積書\n- 宛名 / 発行日 / 有効期限 (発行から30日)\n- 件名\n## 明細 (表)\n| 項目 | 数量 | 単価 | 金額 |\n## 合計 (税抜/消費税/税込)\n## お支払い条件: 月末締め翌月末払い\n## 備考"
            }
            className="mt-0.5 w-full resize-y rounded-md border border-border bg-surface px-sm py-2 font-mono text-[12.5px] leading-relaxed text-on-surface outline-none placeholder:text-on-surface-variant focus-visible:border-primary"
          />
        </label>
        {notice ? (
          <p
            role={notice.kind === "error" ? "alert" : "status"}
            className={cn(
              "mt-2 rounded-md px-sm py-1.5 text-[12px]",
              notice.kind === "error"
                ? "bg-error/10 text-error"
                : "bg-tertiary-container text-tertiary-container-fg",
            )}
          >
            {notice.text}
          </p>
        ) : null}
        <div className="mt-3 flex items-center gap-2">
          {existing ? (
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-error transition-colors hover:bg-error/10 disabled:opacity-50"
            >
              {remove.isPending ? "削除中…" : "テンプレを削除"}
            </button>
          ) : null}
          <button
            type="submit"
            disabled={content.trim() === "" || save.isPending}
            className="ml-auto rounded-md bg-primary px-4 py-1.5 text-[12.5px] font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {save.isPending ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </section>
  );
}
