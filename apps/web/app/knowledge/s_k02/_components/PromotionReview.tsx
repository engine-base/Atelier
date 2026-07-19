/**
 * S-K02 ナレッジ昇格レビュー — T-UC-19 / モック忠実再構築 v2
 *
 * モック S-K02-review.html の 2 ペイン構成:
 *   左: 書込候補リスト (カテゴリ badge + タイトル + プレビュー + 信頼度 + 相対時刻)
 *   右: ツールバー → メタ行 (昇格先/カテゴリ/出典/信頼度) → AI 抽出バナー →
 *      タイトル編集 input → タグ編集 → 本文 (NoteMarkdown / 編集時 textarea) →
 *      採用して書込 / 編集して採用 / 却下
 *
 * Rule 10:
 *   - タイトル/タグ/カテゴリ/本文の編集は実 PATCH に接続 (onApprove へ draft を渡す)
 *   - 却下は実 API (onReject → DELETE) — 以前はクライアント側 dismiss のみで
 *     リロードすると復活する偽装だった
 *   - 一括承認は 2 段階確認 (誤爆防止)
 *   - employee_specific 候補は API 制約 (workspace common と整合しない) により
 *     昇格ボタンを出さず理由を表示
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { Check, Pencil, Sparkles, X } from "lucide-react";

import { cn } from "../../../../lib/cn";
import { relTime } from "../../../../lib/format";
import { NoteMarkdown } from "../../s_k01/_components/NoteMarkdown";

export interface PromotionItem {
  readonly id: string;
  readonly title: string;
  readonly confidence: number;
  readonly content: string;
  readonly source: string;
  readonly category?: string;
  readonly tags?: readonly string[];
  readonly createdAt?: string;
  /** employee_specific は API 制約で昇格不可。 */
  readonly promotable?: boolean;
}

/** 編集して採用の下書き (PATCH /knowledge/{id} に渡す)。 */
export interface PromotionDraft {
  readonly title: string;
  readonly content_md: string;
  readonly tags: readonly string[];
  readonly category: string;
}

export interface PromotionReviewProps {
  readonly items: readonly PromotionItem[];
  /** 採用して書込。draft は編集があった場合のみ (PATCH → promote)。 */
  readonly onApprove: (id: string, draft?: PromotionDraft) => void;
  /** 却下 (実 DELETE)。 */
  readonly onReject: (id: string) => void;
  readonly busy?: boolean;
  /** カテゴリ select の候補 (既存カテゴリ集合)。 */
  readonly categories?: readonly string[];
}

interface ConfidenceTone {
  readonly label: string;
  readonly text: string;
  readonly badge: string;
}

function toneFor(confidence: number): ConfidenceTone {
  if (confidence >= 0.8) {
    return {
      label: "高",
      text: "text-tertiary",
      badge: "bg-tertiary-container text-tertiary-container-fg",
    };
  }
  if (confidence >= 0.5) {
    return {
      label: "中",
      text: "text-on-surface-variant",
      badge: "bg-surface-variant text-on-surface-variant",
    };
  }
  return {
    label: "低",
    text: "text-error",
    badge: "bg-[#FEE2E2] text-[#991B1B]",
  };
}

function pct(confidence: number): string {
  return `${(confidence * 100).toFixed(0)}%`;
}

const BADGE_BASE =
  "inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[10.5px] font-semibold";

export function PromotionReview({
  items,
  onApprove,
  onReject,
  busy,
  categories = [],
}: PromotionReviewProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    items[0]?.id,
  );
  const selected = items.find((it) => it.id === selectedId) ?? items[0];

  // 編集状態 (タイトルは常時編集可、本文は「編集して採用」で開く — モック準拠)
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState<readonly string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [editingBody, setEditingBody] = useState(false);
  const [body, setBody] = useState("");
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);

  useEffect(() => {
    if (!selected) return;
    setTitle(selected.title);
    setCategory(selected.category ?? "");
    setTags(selected.tags ?? []);
    setTagInput("");
    setEditingBody(false);
    setBody(selected.content);
    setConfirmReject(false);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (items.length === 0 || !selected) {
    return (
      <p className="py-12 text-center text-body-md text-on-surface-variant">
        レビュー対象なし
      </p>
    );
  }

  const selectedTone = toneFor(selected.confidence);
  const promotable = selected.promotable !== false;
  const dirty =
    title !== selected.title ||
    body !== selected.content ||
    category !== (selected.category ?? "") ||
    JSON.stringify(tags) !== JSON.stringify(selected.tags ?? []);

  const draft = (): PromotionDraft | undefined =>
    dirty
      ? {
          title: title.trim() || selected.title,
          content_md: body.trim() || selected.content,
          tags,
          category: category || selected.category || "general",
        }
      : undefined;

  const addTag = (): void => {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  };

  const promotableItems = items.filter((it) => it.promotable !== false);

  return (
    <section
      aria-label="ナレッジ昇格レビュー"
      className="grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-white shadow-sm lg:grid-cols-[360px_1fr]"
    >
      {/* 左: 書込候補リスト */}
      <aside className="flex flex-col border-b border-border lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-3 border-b border-border px-[18px] py-[14px]">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
              AI 提案
            </div>
            <strong className="text-sm font-bold text-on-surface">
              書込候補（{items.length}）
            </strong>
          </div>
          {confirmBulk ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  promotableItems.forEach((it) => onApprove(it.id));
                  setConfirmBulk(false);
                }}
                className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary hover:bg-[#1E54D8] disabled:opacity-50"
              >
                {promotableItems.length} 件を昇格
              </button>
              <button
                type="button"
                onClick={() => setConfirmBulk(false)}
                className="inline-flex items-center rounded-md px-2 py-1.5 text-xs font-semibold text-on-surface-variant hover:bg-surface-variant"
              >
                やめる
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmBulk(true)}
              disabled={promotableItems.length === 0}
              className="inline-flex items-center rounded-md border border-primary px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary-container disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              一括承認
            </button>
          )}
        </div>

        <ul role="list" className="flex flex-col">
          {items.map((it) => {
            const isSelected = it.id === selected.id;
            const tone = toneFor(it.confidence);
            return (
              <li key={it.id}>
                <button
                  type="button"
                  aria-current={isSelected}
                  onClick={() => setSelectedId(it.id)}
                  className={cn(
                    "w-full border-b border-border px-[18px] py-[14px] text-left transition-colors hover:bg-surface-variant",
                    isSelected &&
                      "border-l-[3px] border-l-primary bg-primary-container pl-[15px]",
                  )}
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    {it.category ? (
                      <span
                        className={cn(
                          BADGE_BASE,
                          "bg-tertiary-container text-tertiary-container-fg",
                        )}
                      >
                        {it.category}
                      </span>
                    ) : null}
                    {it.promotable !== false ? (
                      <span
                        className={cn(
                          BADGE_BASE,
                          "bg-primary-container text-primary-container-fg",
                        )}
                      >
                        昇格候補
                      </span>
                    ) : (
                      <span
                        className={cn(
                          BADGE_BASE,
                          "bg-surface-variant text-on-surface-variant",
                        )}
                      >
                        社員別 (昇格不可)
                      </span>
                    )}
                  </div>
                  <div className="mb-1 text-[13.5px] font-bold leading-snug text-on-surface">
                    {it.title}
                  </div>
                  <p className="line-clamp-2 text-xs text-on-surface-variant">
                    {it.content}
                  </p>
                  <div className="mt-2 flex items-center gap-1.5">
                    <span
                      className={cn(
                        "text-[11px] font-semibold tabular-nums",
                        tone.text,
                      )}
                    >
                      信頼度 {it.confidence.toFixed(2)}
                    </span>
                    {it.createdAt ? (
                      <span className="ml-auto text-[10.5px] tabular-nums text-on-surface-variant">
                        {relTime(it.createdAt)}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      {/* 右: 抽出内容 + アクション */}
      <div className="flex flex-col bg-surface">
        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3">
          <span
            className={cn(
              BADGE_BASE,
              "bg-tertiary-container text-tertiary-container-fg",
            )}
          >
            {selected.category ?? selected.source} · 昇格候補
          </span>
          <span className="text-sm text-on-surface-variant">
            出典: {selected.source} · 信頼度 {selected.confidence.toFixed(2)}
          </span>
        </div>

        {/* meta row (モック 4 列) */}
        <div className="grid grid-cols-2 gap-4 border-b border-border bg-surface-variant px-6 py-4 lg:grid-cols-4 lg:px-8">
          <div>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-on-surface-variant">
              昇格先
            </div>
            <div className="text-[13px] font-semibold text-on-surface">
              common（共通ナレッジ）
            </div>
          </div>
          <div>
            <label className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.06em] text-on-surface-variant">
              カテゴリ
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-white px-2 py-1.5 text-[12px] font-semibold text-on-surface focus:border-primary focus:outline-none"
              >
                {[...new Set([category, ...categories])]
                  .filter(Boolean)
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-on-surface-variant">
              出典
            </div>
            <div className="text-[13px] font-semibold text-on-surface">
              {selected.source}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-on-surface-variant">
              信頼度
            </div>
            <div className="flex items-center gap-2">
              <strong
                className={cn("text-[13px] tabular-nums", selectedTone.text)}
              >
                {selected.confidence.toFixed(2)}
              </strong>
              <span className={cn(BADGE_BASE, selectedTone.badge)}>
                {selectedTone.label}
              </span>
            </div>
          </div>
        </div>

        {/* body */}
        <div className="flex-1 overflow-y-auto px-6 py-7 lg:px-8">
          <div className="mb-5 flex items-start gap-2.5 rounded-md bg-tertiary-container px-4 py-3 text-[12.5px] text-tertiary-container-fg">
            <Sparkles className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <strong>{selected.source}による提案：</strong>
              <p className="mt-1">
                類似パターンを検出しました。共通ナレッジへの昇格を提案します。内容を確認・編集して採用してください。
              </p>
            </div>
          </div>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="昇格候補タイトル"
            className="mb-4 w-full border-none bg-transparent text-[20px] font-bold leading-tight tracking-tight text-on-surface outline-none focus:ring-0 lg:text-[26px]"
          />

          {/* タグ編集 (モック editor-tags-input) */}
          <div className="mb-5 flex flex-wrap items-center gap-1.5 rounded-md bg-surface-variant px-3 py-2">
            {tags.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-primary-container px-2.5 py-0.5 text-[11px] font-semibold text-primary-container-fg"
              >
                {t}
                <button
                  type="button"
                  aria-label={`タグ ${t} を削除`}
                  onClick={() => setTags(tags.filter((x) => x !== t))}
                  className="opacity-70 hover:opacity-100"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
              aria-label="タグを追加"
              placeholder="+ タグ追加"
              className="min-w-[80px] flex-1 border-none bg-transparent text-[11.5px] text-on-surface outline-none placeholder:text-on-surface-variant"
            />
          </div>

          {editingBody ? (
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-label="本文を編集"
              rows={14}
              className="w-full rounded-md border border-primary bg-white px-5 py-4 text-sm leading-[1.85] text-on-surface focus:outline-none"
            />
          ) : (
            <div className="rounded-md border border-border bg-white px-6 py-5">
              <NoteMarkdown content={body} />
            </div>
          )}
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-3 border-t border-border bg-white px-6 py-4 lg:px-8">
          {promotable ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onApprove(selected.id, draft())}
              aria-label={`${selected.title} を昇格`}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              {dirty ? "編集を保存して書込" : "採用して書込"}
            </button>
          ) : (
            <span className="text-sm text-on-surface-variant">
              社員別スキルナレッジは共通へ昇格できません（API 制約）
            </span>
          )}
          {!editingBody && promotable ? (
            <button
              type="button"
              onClick={() => setEditingBody(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm font-semibold text-on-surface transition-colors hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              編集して採用
            </button>
          ) : null}
          {confirmReject ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => onReject(selected.id)}
                className="inline-flex items-center rounded-md bg-error px-3 py-2 text-sm font-semibold text-on-error hover:opacity-90 disabled:opacity-50"
              >
                却下して削除
              </button>
              <button
                type="button"
                onClick={() => setConfirmReject(false)}
                className="inline-flex items-center rounded-md px-3 py-2 text-sm font-semibold text-on-surface-variant hover:bg-surface-variant"
              >
                やめる
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReject(true)}
              aria-label={`${selected.title} を却下`}
              className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              却下
            </button>
          )}
          <span
            aria-label={`信頼度 ${pct(selected.confidence)}`}
            className="ml-auto hidden text-sm text-on-surface-variant sm:inline"
          >
            採用後、埋め込みが生成され RAG 検索対象になります
          </span>
        </div>
      </div>
    </section>
  );
}
