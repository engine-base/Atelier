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
import { cn } from "../../../../lib/cn";

const Schema = z.object({
  customer: z.string().min(1, "入力必須"),
  opportunity: z.string().min(1, "入力必須"),
  summary: z.string().min(10, "10 文字以上で入力してください"),
});
export type SalesDraftValues = z.infer<typeof Schema>;

export interface SalesDocDraftProps {
  readonly onDraft: (v: SalesDraftValues) => Promise<string>;
  /** 生成済みドラフト本文の編集を保存 (PATCH /sales-docs/{id})。未指定なら編集不可。 */
  readonly onEdit?: (content: string) => Promise<void>;
}

const INPUT_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-[14px] text-on-surface transition focus:border-primary focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-primary-container";

/** 種別タブ (ドキュメント種別)。proposal を active 表示。
 *  以前は "v3/v2/draft" 等の版数バッジをべた書きしていたが、実ドキュメントの
 *  有無に関係なく既存版があるように見える虚偽表示だったため撤去した。 */
const DOC_TABS: ReadonlyArray<{ label: string; active: boolean }> = [
  { label: "提案書", active: true },
  { label: "見積書", active: false },
  { label: "業務委託契約", active: false },
  { label: "NDA", active: false },
  { label: "請求書", active: false },
];

/** 生成の流れ (参考)。以前は "過去類似3案件"/"35機能87タスク" 等の具体数を
 *  実行済みかのように出していたが、生成トレース API が無く虚偽のため汎用手順に是正。 */
const PROCESS_STEPS: readonly string[] = [
  "過去の類似案件・ナレッジを参照",
  "機能分解から工数を算出",
  "フェーズ別に項目を構成",
  "価格を市場相場と照合",
  "人間レビューで承認・確定",
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
        </span>
      ))}
    </div>
  );
}

/** 生成の流れ (参考手順)。実行トレースではなく、AI 提案ドラフトの作り方の説明。 */
function ProcessCard() {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <h3 className="mb-3 text-[14px] font-bold tracking-tight text-on-surface">
        生成の流れ
      </h3>
      <ol className="flex flex-col">
        {PROCESS_STEPS.map((step, i) => (
          <li
            key={step}
            className={
              "flex items-center gap-2.5 py-2.5 text-[12.5px] text-on-surface " +
              (i < PROCESS_STEPS.length - 1 ? "border-b border-border" : "")
            }
          >
            <span
              className="flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full bg-surface-variant text-[11px] font-semibold text-on-surface-variant tabular-nums"
              aria-hidden="true"
            >
              {i + 1}
            </span>
            <span className="font-medium">{step}</span>
          </li>
        ))}
      </ol>
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

/** 生成済みドキュメントのプレビュー (toolbar + アクション + 本文)。
 *  onEdit 指定時は「編集」ボタンで本文を編集して PATCH /sales-docs/{id} に保存できる。 */
function DocPreview({
  draft,
  onEdit,
}: {
  readonly draft: string;
  readonly onEdit?: (content: string) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(draft);
  const [saving, setSaving] = useState(false);

  const startEdit = (): void => {
    setContent(draft);
    setEditing(true);
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onEdit?.(content);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

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
          {TOOLBAR_ACTIONS.map((action) => {
            // 「編集」は onEdit 配線時のみ機能。他(修正依頼/PDF/送信)は API 無し
            // のため onEdit 未配線時と同じく非活性の視覚クロームとして残す。
            if (action.label === "編集") {
              if (!onEdit) return null;
              return (
                <button
                  key={action.label}
                  type="button"
                  onClick={editing ? () => setEditing(false) : startEdit}
                  className={toolbarBtnClass(action.variant)}
                >
                  {editing ? "編集をやめる" : "編集"}
                </button>
              );
            }
            return (
              <button
                key={action.label}
                type="button"
                disabled
                className={cn(toolbarBtnClass(action.variant), "opacity-50")}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      </div>

      <article
        aria-label="生成ドラフト"
        className="max-h-[720px] overflow-y-auto px-14 py-10"
      >
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Proposal / 提案ドラフト
        </div>
        {editing ? (
          <div className="flex flex-col gap-3">
            <label className="sr-only" htmlFor="sales-draft-edit">
              ドラフト本文
            </label>
            <textarea
              id="sales-draft-edit"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={18}
              className="w-full rounded-md border border-border bg-surface px-3 py-2 font-sans text-[14px] leading-[1.8] text-on-surface focus:border-primary focus:outline-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex h-9 items-center rounded-md px-3 text-[13px] font-semibold text-on-surface hover:bg-surface-variant"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-[13px] font-semibold text-on-primary hover:bg-[#1E54D8] disabled:opacity-50"
              >
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap font-sans text-[14px] leading-[1.8] text-on-surface">
            {draft}
          </pre>
        )}
        <p className="mt-6 text-[13px] text-on-surface-variant">
          ※ 本ドラフトは AI 補助で作成されています。最終版は人間レビュー後に確定されます。
        </p>
      </article>
    </div>
  );
}

export function SalesDocDraft({ onDraft, onEdit }: SalesDocDraftProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { customer: "", opportunity: "", summary: "" },
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleEditSave = onEdit
    ? async (content: string): Promise<void> => {
        await onEdit(content);
        setDraft(content); // 保存成功で表示も更新
      }
    : undefined;

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
          {draft && !loading ? (
            <DocPreview draft={draft} onEdit={handleEditSave} />
          ) : null}
        </div>

        <aside className="flex flex-col gap-4">
          <ProcessCard />
          <SendHistoryCard />
        </aside>
      </div>
    </section>
  );
}
