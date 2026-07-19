/**
 * S-N01 商談ドラフト — T-UC-24 (design-audit v2)
 *
 * 見た目は 06_mockups/sales/S-N01-drafts.html に忠実:
 *   page-header → 種別タブ → (フォーム + ドキュメント一覧/プレビュー | サイドバー)。
 *
 * design-audit v2 での是正:
 *   - 死にタブ 5 → API が持つ 提案書/見積書 の実タブ (件数バッジは実データ)。
 *     業務委託契約/NDA/請求書 は doc_type 未対応のため撤去 + GAP-018
 *   - disabled placeholder (修正依頼/PDF/送信) は Rule 10 違反 → 修正依頼=チャットへの実リンク、
 *     PDF/送信/送信履歴カードは API 不在のため撤去 + GAP-018
 *   - 保存済みドキュメントが一覧されずリロードで消えた → GET /sales-docs 実一覧 (版数つき)
 *   - 削除 (論理) を 2 段階確認で追加
 */

"use client";

import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import { MessageSquare, Trash2 } from "lucide-react";
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

export type DocType = "proposal" | "estimate";

export interface SalesDocRow {
  readonly id: string;
  readonly docType: DocType;
  readonly summary: string;
  readonly version: number;
  readonly createdAt: string;
}

export const DOC_TYPE_LABEL: Readonly<Record<DocType, string>> = {
  proposal: "提案書",
  estimate: "見積書",
};

const INPUT_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-[14px] text-on-surface transition focus:border-primary focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-primary-container";

/** 生成の流れ (参考手順)。実行トレース API は無いため、具体数の虚偽表示はしない。 */
const PROCESS_STEPS: readonly string[] = [
  "過去の類似案件・ナレッジを参照",
  "機能分解から工数を算出",
  "フェーズ別に項目を構成",
  "価格を市場相場と照合",
  "人間レビューで承認・確定",
];

function dateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface SalesDocDraftProps {
  readonly docType: DocType;
  readonly onDocTypeChange: (t: DocType) => void;
  readonly docs: readonly SalesDocRow[];
  readonly docsLoading?: boolean;
  readonly docsError?: boolean;
  readonly counts: Readonly<Record<DocType, number>>;
  readonly onDraft: (v: SalesDraftValues) => Promise<SalesDocRow>;
  readonly onEdit: (id: string, content: string) => Promise<void>;
  readonly onDelete: (id: string) => void;
  /** 「修正依頼」の遷移先 (プロジェクトチャット)。 */
  readonly chatHref: string;
}

function DocTabs({
  active,
  counts,
  onChange,
}: {
  readonly active: DocType;
  readonly counts: Readonly<Record<DocType, number>>;
  readonly onChange: (t: DocType) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="ドキュメント種別"
      className="mb-6 flex gap-1 overflow-x-auto border-b border-border"
    >
      {(Object.keys(DOC_TYPE_LABEL) as DocType[]).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={active === t}
          onClick={() => onChange(t)}
          className={
            "flex items-center gap-2 whitespace-nowrap border-b-2 px-[18px] py-3 text-[13px] font-semibold transition " +
            (active === t
              ? "border-primary text-primary"
              : "border-transparent text-on-surface-variant hover:text-on-surface")
          }
        >
          {DOC_TYPE_LABEL[t]}
          <span
            className={
              "rounded-full px-[7px] py-px text-[10.5px] font-bold " +
              (active === t
                ? "bg-primary-container text-on-primary-container"
                : "bg-surface-variant text-on-surface-variant")
            }
          >
            {counts[t]}
          </span>
        </button>
      ))}
    </div>
  );
}

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

/** 保存済みドキュメント一覧 (版数つき)。クリックでプレビュー、削除は 2 段階。 */
function DocHistory({
  docs,
  loading,
  error,
  selectedId,
  onSelect,
  onDelete,
}: {
  readonly docs: readonly SalesDocRow[];
  readonly loading?: boolean;
  readonly error?: boolean;
  readonly selectedId: string | null;
  readonly onSelect: (row: SalesDocRow) => void;
  readonly onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <h3 className="mb-3 text-[14px] font-bold tracking-tight text-on-surface">
        保存済みドキュメント
      </h3>
      {error ? (
        <p role="alert" className="text-[13px] text-error">
          一覧の取得に失敗しました。
        </p>
      ) : loading ? (
        <p className="text-[13px] text-on-surface-variant">読み込み中…</p>
      ) : docs.length === 0 ? (
        <p className="text-[13px] text-on-surface-variant">
          まだドキュメントがありません。
        </p>
      ) : (
        <ul className="flex flex-col">
          {docs.map((d, i) => (
            <li
              key={d.id}
              className={
                "flex items-center gap-2 py-2 " +
                (i < docs.length - 1 ? "border-b border-border" : "")
              }
            >
              <button
                type="button"
                onClick={() => onSelect(d)}
                aria-current={selectedId === d.id ? "true" : undefined}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-1.5 py-1 text-left transition hover:bg-surface-variant",
                  selectedId === d.id && "bg-primary-container/40",
                )}
              >
                <span className="rounded-sm bg-surface-variant px-1.5 py-0.5 text-[10.5px] font-bold text-on-surface-variant">
                  v{d.version}
                </span>
                <span className="truncate text-[13px] font-medium text-on-surface">
                  {d.summary.split("\n")[0]?.replace(/^#\s*/, "") || "(無題)"}
                </span>
                <span className="ml-auto shrink-0 text-[11.5px] text-on-surface-variant">
                  {dateLabel(d.createdAt)}
                </span>
              </button>
              {confirming === d.id ? (
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirming(null);
                      onDelete(d.id);
                    }}
                    className="rounded-sm px-1.5 py-1 text-[12px] font-semibold text-error hover:bg-surface-variant"
                  >
                    削除する
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded-sm px-1.5 py-1 text-[12px] text-on-surface-variant hover:bg-surface-variant"
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`v${d.version} を削除`}
                  onClick={() => setConfirming(d.id)}
                  className="shrink-0 rounded-sm p-1.5 text-error transition hover:bg-surface-variant"
                >
                  <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** ドキュメントプレビュー (toolbar + 本文 + 編集)。 */
function DocPreview({
  doc,
  chatHref,
  onEdit,
}: {
  readonly doc: SalesDocRow;
  readonly chatHref: string;
  readonly onEdit: (id: string, content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(doc.summary);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState(doc.summary);

  // 別ドキュメント選択時に表示を差し替える
  React.useEffect(() => {
    setView(doc.summary);
    setContent(doc.summary);
    setEditing(false);
  }, [doc.id, doc.summary]);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onEdit(doc.id, content);
      setView(content);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-variant px-[18px] py-3">
        <span className="inline-flex items-center gap-1 rounded-sm bg-primary-container px-2 py-0.5 text-[10.5px] font-semibold text-on-primary-container">
          v{doc.version} · {DOC_TYPE_LABEL[doc.docType]}
        </span>
        <span className="text-[13px] text-on-surface-variant">
          {dateLabel(doc.createdAt)} 作成 · AI 補助ドラフト
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href={chatHref}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface transition hover:bg-white"
          >
            <MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />
            修正依頼
          </Link>
          <button
            type="button"
            onClick={() => (editing ? setEditing(false) : setEditing(true))}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary px-3 py-1.5 text-[12px] font-semibold text-primary transition hover:bg-primary-container"
          >
            {editing ? "編集をやめる" : "編集"}
          </button>
        </div>
      </div>

      <article
        aria-label="生成ドラフト"
        className="max-h-[720px] overflow-y-auto px-6 py-8 lg:px-14 lg:py-10"
      >
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          {doc.docType === "estimate" ? "Estimate / 見積書" : "Proposal / 提案書"}
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
            {view}
          </pre>
        )}
        <p className="mt-6 text-[13px] text-on-surface-variant">
          ※ 本ドラフトは AI 補助で作成されています。最終版は人間レビュー後に確定されます。
        </p>
      </article>
    </div>
  );
}

export function SalesDocDraft({
  docType,
  onDocTypeChange,
  docs,
  docsLoading,
  docsError,
  counts,
  onDraft,
  onEdit,
  onDelete,
  chatHref,
}: SalesDocDraftProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { customer: "", opportunity: "", summary: "" },
  });
  const [selected, setSelected] = useState<SalesDocRow | null>(null);
  const [loading, setLoading] = useState(false);

  // 一覧が更新されたら selected を最新の同 id 行へ追従する。
  // (作成直後は一覧再取得前で不在になり得るため、不在でも選択は解除しない —
  //  削除時の解除は onDelete ハンドラ側で行う)
  React.useEffect(() => {
    if (!selected) return;
    const cur = docs.find((d) => d.id === selected.id);
    if (cur && cur.summary !== selected.summary) setSelected(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  return (
    <section className="flex flex-col gap-7">
      <header>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Sales Drafts · トニー + ナターシャ
        </p>
        <h1 className="mb-2 text-[24px] font-bold leading-tight tracking-tight text-on-surface lg:text-[28px]">
          提案 / 見積ドラフト
        </h1>
        <p className="text-[14px] text-on-surface-variant">
          ナレッジの過去成約パターンから自動生成。修正はチャットで行えます。
        </p>
      </header>

      <div>
        <DocTabs active={docType} counts={counts} onChange={onDocTypeChange} />

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-5">
            <div className="rounded-lg border border-border bg-white p-5">
              <h2 className="mb-4 text-[16px] font-bold tracking-tight text-on-surface">
                商談メモから{DOC_TYPE_LABEL[docType]}を生成
              </h2>
              <Form
                form={form}
                onValid={async (v) => {
                  setLoading(true);
                  try {
                    const row = await onDraft(v);
                    setSelected(row);
                    form.reset({ customer: "", opportunity: "", summary: "" });
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
            {selected && !loading ? (
              <DocPreview doc={selected} chatHref={chatHref} onEdit={onEdit} />
            ) : null}
          </div>

          <aside className="flex flex-col gap-4">
            <DocHistory
              docs={docs}
              loading={docsLoading}
              error={docsError}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              onDelete={(id) => {
                onDelete(id);
                if (selected?.id === id) setSelected(null);
              }}
            />
            <ProcessCard />
          </aside>
        </div>
      </div>
    </section>
  );
}
