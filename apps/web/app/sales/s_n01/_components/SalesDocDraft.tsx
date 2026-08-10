/**
 * S-N01 商談ドラフト — T-UC-24 / GAP-018
 *
 * 見た目は 06_mockups/sales/S-N01-drafts.html に忠実:
 *   page-header → 種別タブ 5 (提案/見積/業務委託契約/NDA/請求書 — 実 doc_type) →
 *   (フォーム + プレビュー | サイドバー: 保存済み/生成プロセス/参照ナレッジ/送信履歴)。
 *
 * GAP-018 で全要素を実 API 配線:
 *   - 「トニーにドラフト生成を依頼」= AI 生成 (ナレッジ RAG。明示操作起点 —
 *     自動生成しない)。AI を使わない構造化保存も残す (LLM 未設定環境の導線)
 *   - 生成プロセス / 参照ナレッジ = 実生成トレース (meta) のみ表示。
 *     トレースが無いドキュメントは参考手順を「参考」と明示して表示
 *   - PDF = GET /sales-docs/{id}/pdf の実バイナリ DL
 *   - 送信 = メールダイアログ → POST /send (dry_run は正直に表示) + 送信履歴
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

export type DocType = "proposal" | "estimate" | "contract" | "nda" | "invoice";

export interface SalesKnowledgeRef {
  readonly id: string;
  readonly title: string;
  readonly category?: string;
}

export interface SalesDocRow {
  readonly id: string;
  readonly docType: DocType;
  readonly summary: string;
  readonly version: number;
  readonly createdAt: string;
  /** GAP-018: 生成トレース (meta 由来。手動作成ドキュメントには無い)。 */
  readonly generatedBy?: string;
  readonly model?: string;
  readonly knowledgeRefs?: readonly SalesKnowledgeRef[];
  readonly steps?: readonly string[];
}

export interface SalesSendRow {
  readonly id: string;
  readonly toEmail: string;
  readonly subject: string;
  readonly dryRun: boolean;
  readonly createdAt: string;
}

export const DOC_TYPE_LABEL: Readonly<Record<DocType, string>> = {
  proposal: "提案書",
  estimate: "見積書",
  contract: "業務委託契約",
  nda: "NDA",
  invoice: "請求書",
};

const DOC_EYEBROW: Readonly<Record<DocType, string>> = {
  proposal: "Proposal / 提案書",
  estimate: "Estimate / 見積書",
  contract: "Contract / 業務委託契約書",
  nda: "NDA / 秘密保持契約書",
  invoice: "Invoice / 請求書",
};

const INPUT_CLASS =
  "w-full rounded-md border border-transparent bg-surface-variant px-3.5 py-2.5 text-[14px] text-on-surface transition focus:border-primary focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-primary-container";

/** 生成の流れ (参考手順)。トレースが無い手動作成ドキュメント向けの説明。 */
const PROCESS_STEPS: readonly string[] = [
  "過去の類似案件・ナレッジを参照",
  "トニーが本文を生成",
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
  /** AI 生成 (トニー + ナレッジ RAG)。 */
  readonly onGenerate: (v: SalesDraftValues) => Promise<SalesDocRow>;
  /** AI を使わない構造化保存 (LLM 未設定環境の導線)。 */
  readonly onSaveRaw: (v: SalesDraftValues) => Promise<SalesDocRow>;
  readonly onEdit: (id: string, content: string) => Promise<void>;
  readonly onDelete: (id: string) => void;
  /** 「修正依頼」の遷移先 (プロジェクトチャット)。 */
  readonly chatHref: string;
  /** 選択ドキュメント (controlled — 送信履歴の取得のためコンテナが保持)。 */
  readonly selected: SalesDocRow | null;
  readonly onSelect: (row: SalesDocRow | null) => void;
  /** GAP-018: PDF DL / メール送信 / 送信履歴。 */
  readonly onPdf?: (id: string) => void;
  readonly onSend?: (
    id: string,
    input: { toEmail: string; subject?: string; message?: string },
  ) => void;
  readonly sending?: boolean;
  readonly sends?: readonly SalesSendRow[];
  readonly sendsLoading?: boolean;
  readonly actionNotice?: string;
  readonly actionError?: string;
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

/** 生成プロセス (実トレース優先 — GAP-018)。 */
function ProcessCard({ doc }: { readonly doc: SalesDocRow | null }) {
  const traced = doc?.steps && doc.steps.length > 0;
  const steps = traced
    ? [...(doc?.steps ?? []), "人間レビューで承認・確定"]
    : PROCESS_STEPS;
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <h3 className="mb-3 text-[14px] font-bold tracking-tight text-on-surface">
        生成プロセス
        {!traced ? (
          <span className="ml-1.5 text-[11px] font-medium text-on-surface-variant">
            （参考手順）
          </span>
        ) : null}
      </h3>
      <ol className="flex flex-col">
        {steps.map((step, i) => {
          const isPending = i === steps.length - 1;
          return (
            <li
              key={step}
              className={
                "flex items-center gap-2.5 py-2.5 text-[12.5px] text-on-surface " +
                (i < steps.length - 1 ? "border-b border-border" : "")
              }
            >
              <span
                className={cn(
                  "flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
                  traced && !isPending
                    ? "bg-tertiary text-on-tertiary"
                    : "bg-surface-variant text-on-surface-variant",
                )}
                aria-hidden="true"
              >
                {traced && !isPending ? "✓" : i + 1}
              </span>
              <span className={cn("font-medium", isPending && traced && "text-on-surface-variant")}>
                {step}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** 参照ナレッジ (実生成トレースのみ — 推測ソースは出さない)。 */
function KnowledgeRefsCard({ doc }: { readonly doc: SalesDocRow | null }) {
  const refs = doc?.knowledgeRefs ?? [];
  if (!doc?.generatedBy || refs.length === 0) return null;
  return (
    <div className="rounded-lg bg-secondary-container p-5 text-secondary-container-fg">
      <h3 className="mb-2 text-[14px] font-bold tracking-tight">参照ナレッジ</h3>
      <ul className="flex flex-col gap-1.5">
        {refs.map((r) => (
          <li key={r.id} className="rounded-md bg-white/60 px-3 py-2.5 text-[12px]">
            <strong className="font-bold">{r.title}</strong>
            {r.category ? (
              <div className="mt-0.5 text-[11.5px] opacity-85">{r.category}</div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 送信履歴 + 送信ボタン (GAP-018)。 */
function SendHistoryCard({
  doc,
  sends,
  loading,
  onOpenSend,
}: {
  readonly doc: SalesDocRow | null;
  readonly sends?: readonly SalesSendRow[];
  readonly loading?: boolean;
  readonly onOpenSend?: () => void;
}) {
  if (!doc) return null;
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <h3 className="mb-3 text-[14px] font-bold tracking-tight text-on-surface">
        送信履歴
      </h3>
      {loading ? (
        <p className="text-[13px] text-on-surface-variant">読み込み中…</p>
      ) : !sends || sends.length === 0 ? (
        <p className="text-[13px] text-on-surface-variant">
          まだ送信されていません
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sends.map((s) => (
            <li key={s.id} className="rounded-md bg-surface-variant px-3 py-2 text-[12px]">
              <div className="font-semibold text-on-surface">{s.toEmail}</div>
              <div className="mt-0.5 flex items-center gap-2 text-on-surface-variant">
                <span className="tabular-nums">{dateLabel(s.createdAt)}</span>
                {s.dryRun ? (
                  <span className="rounded-sm bg-secondary-container px-1.5 py-0.5 text-[10px] font-semibold text-secondary-container-fg">
                    dry-run（メール未設定）
                  </span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {onOpenSend ? (
        <button
          type="button"
          onClick={onOpenSend}
          className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary transition hover:bg-[#1E54D8]"
        >
          クライアントにメール送信
        </button>
      ) : null}
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

/** ドキュメントプレビュー (toolbar: 修正依頼/PDF/編集/送信 + 本文)。 */
function DocPreview({
  doc,
  chatHref,
  onEdit,
  onPdf,
  onSend,
  sending,
  sendOpenSignal,
}: {
  readonly doc: SalesDocRow;
  readonly chatHref: string;
  readonly onEdit: (id: string, content: string) => Promise<void>;
  readonly onPdf?: (id: string) => void;
  readonly onSend?: (
    id: string,
    input: { toEmail: string; subject?: string; message?: string },
  ) => void;
  readonly sending?: boolean;
  /** サイドバーの「クライアントにメール送信」から開くためのシグナル。 */
  readonly sendOpenSignal?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(doc.summary);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState(doc.summary);
  const [sendOpen, setSendOpen] = useState(false);
  const [toEmail, setToEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");

  React.useEffect(() => {
    if ((sendOpenSignal ?? 0) > 0) setSendOpen(true);
  }, [sendOpenSignal]);

  // 別ドキュメント選択時に表示を差し替える
  React.useEffect(() => {
    setView(doc.summary);
    setContent(doc.summary);
    setEditing(false);
    setSendOpen(false);
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
    <div
      id="sales-doc-preview"
      className="overflow-hidden rounded-lg border border-border bg-white"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-variant px-[18px] py-3">
        <span className="inline-flex items-center gap-1 rounded-sm bg-primary-container px-2 py-0.5 text-[10.5px] font-semibold text-on-primary-container">
          v{doc.version} · {DOC_TYPE_LABEL[doc.docType]}
        </span>
        <span className="text-[13px] text-on-surface-variant">
          {dateLabel(doc.createdAt)} 作成
          {doc.generatedBy === "tony" ? " · トニー生成" : ""}
          {doc.knowledgeRefs && doc.knowledgeRefs.length > 0
            ? ` · ナレッジ参照 ${doc.knowledgeRefs.length} 件`
            : ""}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link
            href={chatHref}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface transition hover:bg-white"
          >
            <MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />
            修正依頼
          </Link>
          {onPdf ? (
            <button
              type="button"
              onClick={() => onPdf(doc.id)}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface transition hover:bg-white"
            >
              PDF
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => (editing ? setEditing(false) : setEditing(true))}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary px-3 py-1.5 text-[12px] font-semibold text-primary transition hover:bg-primary-container"
          >
            {editing ? "編集をやめる" : "編集"}
          </button>
          {onSend ? (
            <button
              type="button"
              onClick={() => setSendOpen((v) => !v)}
              aria-expanded={sendOpen}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-on-primary transition hover:bg-[#1E54D8]"
            >
              送信
            </button>
          ) : null}
        </div>
      </div>

      {/* メール送信ダイアログ (GAP-018) */}
      {onSend && sendOpen ? (
        <form
          role="dialog"
          aria-label="クライアントにメール送信"
          className="flex flex-col gap-2 border-b border-border bg-secondary-container/40 px-[18px] py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!toEmail.trim() || sending) return;
            onSend(doc.id, {
              toEmail: toEmail.trim(),
              subject: subject.trim() || undefined,
              message: message.trim() || undefined,
            });
            setSendOpen(false);
          }}
        >
          <h4 className="text-[13px] font-bold text-on-surface">
            クライアントにメール送信
          </h4>
          <label className="block">
            <span className="text-[11.5px] font-semibold text-on-surface">
              宛先メールアドレス
            </span>
            <input
              type="email"
              required
              value={toEmail}
              onChange={(e) => setToEmail(e.target.value)}
              placeholder="client@example.com"
              className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-[11.5px] font-semibold text-on-surface">
              件名（省略時は自動生成）
            </span>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>
          <label className="block">
            <span className="text-[11.5px] font-semibold text-on-surface">
              挨拶文（任意）
            </span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              maxLength={2000}
              className="mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-[13px] text-on-surface outline-none focus:border-primary"
            />
          </label>
          <div className="flex items-center justify-end gap-2">
            {sending ? (
              <span role="status" className="mr-auto text-[12px] text-on-surface-variant">
                送信中…
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setSendOpen(false)}
              className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface-variant hover:bg-white/60"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!toEmail.trim() || sending}
              className="rounded-md bg-primary px-4 py-1.5 text-[12px] font-semibold text-on-primary hover:bg-[#1E54D8] disabled:opacity-50"
            >
              送信する
            </button>
          </div>
        </form>
      ) : null}

      <article
        aria-label="生成ドラフト"
        className="max-h-[720px] overflow-y-auto px-6 py-8 lg:px-14 lg:py-10"
      >
        <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          {DOC_EYEBROW[doc.docType]}
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
  onGenerate,
  onSaveRaw,
  onEdit,
  onDelete,
  chatHref,
  selected,
  onSelect,
  onPdf,
  onSend,
  sending,
  sends,
  sendsLoading,
  actionNotice,
  actionError,
}: SalesDocDraftProps) {
  const form = useAtelierForm({
    schema: Schema,
    defaultValues: { customer: "", opportunity: "", summary: "" },
  });
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [sendOpenSignal, setSendOpenSignal] = useState(0);

  // 一覧が更新されたら selected を最新の同 id 行へ追従する。
  React.useEffect(() => {
    if (!selected) return;
    const cur = docs.find((d) => d.id === selected.id);
    if (cur && cur.summary !== selected.summary) onSelect(cur);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  const submitWith = async (
    fn: (v: SalesDraftValues) => Promise<SalesDocRow>,
    setBusy: (b: boolean) => void,
  ): Promise<void> => {
    const valid = await form.trigger();
    if (!valid) return;
    setBusy(true);
    try {
      const row = await fn(form.getValues());
      onSelect(row);
      form.reset({ customer: "", opportunity: "", summary: "" });
    } catch {
      // エラー表示はコンテナの actionError が担う
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-7">
      <header>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Sales Drafts · トニー + ナターシャ
        </p>
        <h1 className="mb-2 text-[24px] font-bold leading-tight tracking-tight text-on-surface lg:text-[28px]">
          提案 / 見積 / 契約 / 請求書ドラフト
        </h1>
        <p className="text-[14px] text-on-surface-variant">
          ナレッジの過去成約パターンから自動生成。修正はチャットで行えます。
        </p>
      </header>

      <div>
        <DocTabs active={docType} counts={counts} onChange={onDocTypeChange} />

        {actionError ? (
          <p
            role="alert"
            className="mb-4 rounded-md bg-error/10 px-3 py-2 text-[12.5px] text-error"
          >
            {actionError}
          </p>
        ) : actionNotice ? (
          <p
            role="status"
            className="mb-4 rounded-md bg-tertiary-container px-3 py-2 text-[12.5px] text-tertiary-container-fg"
          >
            {actionNotice}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
          <div className="flex flex-col gap-5">
            <div className="rounded-lg border border-border bg-white p-5">
              <h2 className="mb-4 text-[16px] font-bold tracking-tight text-on-surface">
                商談メモから{DOC_TYPE_LABEL[docType]}を生成
              </h2>
              <Form form={form} onValid={async () => {}} className="gap-md">
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
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void submitWith(onGenerate, setGenerating)}
                    disabled={generating || loading}
                    className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-[13px] font-semibold text-on-primary transition hover:bg-[#1E54D8] disabled:opacity-50"
                  >
                    {generating ? "トニーが生成中…" : "トニーにドラフト生成を依頼"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitWith(onSaveRaw, setLoading)}
                    disabled={generating || loading}
                    className="inline-flex h-10 items-center rounded-md border border-border px-4 text-[13px] font-semibold text-on-surface transition hover:bg-surface-variant disabled:opacity-50"
                  >
                    AI を使わず保存
                  </button>
                </div>
              </Form>
            </div>

            {generating || loading ? <Loading /> : null}
            {selected && !generating && !loading ? (
              <DocPreview
                key={selected.id}
                doc={selected}
                chatHref={chatHref}
                onEdit={onEdit}
                onPdf={onPdf}
                onSend={onSend}
                sending={sending}
                sendOpenSignal={sendOpenSignal}
              />
            ) : null}
          </div>

          <aside className="flex flex-col gap-4">
            <DocHistory
              docs={docs}
              loading={docsLoading}
              error={docsError}
              selectedId={selected?.id ?? null}
              onSelect={onSelect}
              onDelete={(id) => {
                onDelete(id);
                if (selected?.id === id) onSelect(null);
              }}
            />
            <ProcessCard doc={selected} />
            <KnowledgeRefsCard doc={selected} />
            <SendHistoryCard
              doc={selected}
              sends={sends}
              loading={sendsLoading}
              onOpenSend={
                selected && onSend
                  ? () => {
                      setSendOpenSignal((n) => n + 1);
                      document
                        .getElementById("sales-doc-preview")
                        ?.scrollIntoView({ behavior: "smooth" });
                    }
                  : undefined
              }
            />
          </aside>
        </div>
      </div>
    </section>
  );
}
