/**
 * S-N01 商談ドラフト — T-UC-24
 *
 * 商談メモから AI 提案ドラフトを生成する UI。
 * - 顧客名 / 案件 / 概要 入力
 * - "ドラフト生成" ボタン → loading → ドラフト表示
 *
 * 見た目は 06_mockups/sales/S-N01-drafts.html に忠実。
 * 種別タブ / 生成フォーム / ドキュメントプレビュー / アクション /
 * 生成プロセス・参照ナレッジ・送信履歴サイドバーで構成する。
 * データ配線 (form / draft / loading / onDraft) は不変。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import { z } from "zod";

import { Field } from "../../../../components/forms/Field";
import { Form, useAtelierForm } from "../../../../components/forms/Form";
import { Loading } from "../../../../components/Loading";

const Schema = z.object({
  customer: z.string().min(1, "入力必須"),
  opportunity: z.string().min(1, "入力必須"),
  summary: z.string().min(10, "10 文字以上で入力してください"),
});
export type SalesDraftValues = z.infer<typeof Schema>;

export interface SalesDocDraftProps {
  readonly onDraft: (v: SalesDraftValues) => Promise<string>;
}

const INPUT_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-[14px] text-on-surface transition focus:border-primary focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-primary-container";

/** 種別タブ (ドラフト一覧 + 種別 badge)。proposal を active 表示。 */
const DOC_TABS: ReadonlyArray<{ label: string; count: string; active: boolean }> =
  [
    { label: "提案書", count: "v3", active: true },
    { label: "見積書", count: "v2", active: false },
    { label: "業務委託契約", count: "v1", active: false },
    { label: "NDA", count: "v1", active: false },
    { label: "請求書", count: "draft", active: false },
  ];

const PROCESS_STEPS: ReadonlyArray<{
  title: string;
  note: string;
  done: boolean;
}> = [
  { title: "ナレッジ参照", note: "過去類似 3 案件", done: true },
  { title: "機能分解から工数算出", note: "35 機能 · 87 タスク", done: true },
  { title: "トニーが項目構成", note: "フェーズ別に集約", done: true },
  { title: "ナターシャが価格レビュー", note: "市場相場との照合済み", done: true },
  { title: "人間レビュー", note: "承認後に確定", done: false },
];

const KNOWLEDGE_SOURCES: ReadonlyArray<{ title: string; note: string }> = [
  { title: "受託案件の提案書テンプレ v3", note: "成約率 +18% パターン · トニー" },
  { title: "SaaS 開発の価格レンジ", note: "業界傾向 · 共通ナレッジ" },
  { title: "Phase 別工数の積算式", note: "トニー専用ナレッジ" },
];

const TOOLBAR_ACTIONS: ReadonlyArray<{ label: string; variant: string }> = [
  { label: "修正依頼", variant: "ghost" },
  { label: "PDF", variant: "ghost" },
  { label: "編集", variant: "outlined" },
  { label: "送信", variant: "primary" },
];

function toolbarBtnClass(variant: string): string {
  const base =
    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition";
  if (variant === "primary") {
    return `${base} bg-primary text-on-primary hover:bg-[#1E54D8]`;
  }
  if (variant === "outlined") {
    return `${base} border border-primary text-primary hover:bg-primary-container`;
  }
  return `${base} text-on-surface hover:bg-surface-variant`;
}

function DocTabs() {
  return (
    <div className="mb-6 flex gap-1 overflow-x-auto border-b border-border">
      {DOC_TABS.map((tab) => (
        <span
          key={tab.label}
          className={
            "flex items-center gap-2 whitespace-nowrap border-b-2 px-[18px] py-3 text-[13px] font-semibold " +
            (tab.active
              ? "border-primary text-primary"
              : "border-transparent text-on-surface-variant")
          }
        >
          {tab.label}
          <span
            className={
              "rounded-full px-[7px] py-px text-[10.5px] font-bold " +
              (tab.active
                ? "bg-primary-container text-on-primary-container"
                : "bg-surface-variant text-on-surface-variant")
            }
          >
            {tab.count}
          </span>
        </span>
      ))}
    </div>
  );
}

function ProcessCard() {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <h3 className="mb-3 text-[14px] font-bold tracking-tight text-on-surface">
        生成プロセス
      </h3>
      {PROCESS_STEPS.map((step, i) => (
        <div
          key={step.title}
          className={
            "flex items-center gap-2.5 py-2.5 text-[12.5px] " +
            (i < PROCESS_STEPS.length - 1 ? "border-b border-border" : "")
          }
        >
          <span
            className={
              "flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full text-[11px] " +
              (step.done
                ? "bg-tertiary text-on-tertiary"
                : "bg-surface-variant text-on-surface-variant")
            }
            aria-hidden="true"
          >
            ✓
          </span>
          <div>
            <div
              className={
                "font-semibold " +
                (step.done ? "text-on-surface" : "text-on-surface-variant")
              }
            >
              {step.title}
            </div>
            <div className="text-[12px] text-on-surface-variant">{step.note}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function KnowledgeCard() {
  return (
    <div className="rounded-lg bg-secondary-container p-5 text-on-secondary-container">
      <h3 className="mb-2 text-[14px] font-bold tracking-tight">参照ナレッジ</h3>
      {KNOWLEDGE_SOURCES.map((src) => (
        <div
          key={src.title}
          className="mb-1.5 rounded-md bg-white/60 px-3 py-2.5 text-[12px]"
        >
          <strong className="font-semibold">{src.title}</strong>
          <div className="mt-0.5 text-[12px] opacity-85">{src.note}</div>
        </div>
      ))}
    </div>
  );
}

function SendHistoryCard() {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <h3 className="mb-3 text-[14px] font-bold tracking-tight text-on-surface">
        送信履歴
      </h3>
      <p className="text-[13px] text-on-surface-variant">
        まだ送信されていません
      </p>
      <button
        type="button"
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary transition hover:bg-[#1E54D8]"
      >
        クライアントにメール送信
      </button>
    </div>
  );
}

/** 生成済みドキュメントのプレビュー (toolbar + アクション + 本文)。 */
function DocPreview({ draft }: { readonly draft: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-variant px-[18px] py-3">
        <span className="inline-flex items-center gap-1 rounded-sm bg-primary-container px-2 py-0.5 text-[10.5px] font-semibold text-on-primary-container">
          提案 · ドラフト
        </span>
        <span className="text-[13px] text-on-surface-variant">
          AI 補助ドラフト · 提案ドキュメントとして保存済み
        </span>
        <div className="ml-auto flex items-center gap-2">
          {TOOLBAR_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              className={toolbarBtnClass(action.variant)}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>

      <article
        aria-label="生成ドラフト"
        className="max-h-[720px] overflow-y-auto px-14 py-10"
      >
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Proposal / 提案ドラフト
        </div>
        <pre className="whitespace-pre-wrap font-sans text-[14px] leading-[1.8] text-on-surface">
          {draft}
        </pre>
        <p className="mt-6 text-[13px] text-on-surface-variant">
          ※ 本ドラフトは AI 補助で作成されています。最終版は人間レビュー後に確定されます。
        </p>
      </article>
    </div>
  );
}

export function SalesDocDraft({ onDraft }: SalesDocDraftProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { customer: "", opportunity: "", summary: "" },
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <section className="flex flex-col gap-7">
      <header>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Sales Drafts · トニー + ナターシャ
        </p>
        <h1 className="mb-2 text-[28px] font-bold leading-tight tracking-tight text-on-surface">
          商談ドラフト
        </h1>
        <p className="text-[14px] text-on-surface-variant">
          ナレッジの過去成約パターンから自動生成。修正はチャットで行えます。
        </p>
      </header>

      <DocTabs />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-5">
          <div className="rounded-lg border border-border bg-white p-5">
            <h2 className="mb-4 text-[16px] font-bold tracking-tight text-on-surface">
              商談メモから生成
            </h2>
            <Form
              form={form}
              onValid={async (v) => {
                setLoading(true);
                try {
                  setDraft(await onDraft(v));
                } finally {
                  setLoading(false);
                }
              }}
              className="gap-md"
            >
              <Field
                label="顧客名"
                required
                error={form.formState.errors.customer?.message}
              >
                <input {...form.register("customer")} className={INPUT_CLASS} />
              </Field>
              <Field
                label="案件"
                required
                error={form.formState.errors.opportunity?.message}
              >
                <input
                  {...form.register("opportunity")}
                  className={INPUT_CLASS}
                />
              </Field>
              <Field
                label="商談概要"
                required
                error={form.formState.errors.summary?.message}
              >
                <textarea
                  {...form.register("summary")}
                  rows={5}
                  className={INPUT_CLASS}
                />
              </Field>
              <button
                type="submit"
                disabled={loading}
                className="inline-flex h-10 w-fit items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-semibold text-on-primary transition hover:bg-[#1E54D8] disabled:opacity-50"
              >
                ドラフト生成
              </button>
            </Form>
          </div>

          {loading ? <Loading /> : null}
          {draft && !loading ? <DocPreview draft={draft} /> : null}
        </div>

        <aside className="flex flex-col gap-4">
          <ProcessCard />
          <KnowledgeCard />
          <SendHistoryCard />
        </aside>
      </div>
    </section>
  );
}
