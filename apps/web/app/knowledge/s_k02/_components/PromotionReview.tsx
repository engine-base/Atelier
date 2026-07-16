/**
 * S-K02 ナレッジ昇格レビュー — T-UC-19
 *
 * AI 抽出ナレッジを「昇格」(common scope 公開) するか「却下」するかをレビュー。
 * モック S-K02-review.html の 2 ペイン構成（左: 書込候補リスト / 右: 抽出内容 +
 * 採用/却下アクション）を忠実に再構築。confidence_score・content_md・source_type は
 * すべて実データ (props) にバインドする。
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";

export interface PromotionItem {
  readonly id: string;
  readonly title: string;
  readonly confidence: number;
  readonly content: string;
  readonly source: string;
}

export interface PromotionReviewProps {
  readonly items: readonly PromotionItem[];
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
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
}: PromotionReviewProps) {
  const [selectedId, setSelectedId] = React.useState<string | undefined>(
    items[0]?.id,
  );

  if (items.length === 0) {
    return (
      <p className="py-12 text-center text-body-md text-on-surface-variant">
        レビュー対象なし
      </p>
    );
  }

  const selected = items.find((it) => it.id === selectedId) ?? items[0]!;
  const selectedTone = toneFor(selected.confidence);

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
          <button
            type="button"
            onClick={() => items.forEach((it) => onApprove(it.id))}
            className="inline-flex items-center rounded-md border border-primary px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary-container focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            一括承認
          </button>
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
                  <div className="mb-1.5 flex items-center gap-1.5">
                    <span
                      className={cn(
                        BADGE_BASE,
                        "bg-tertiary-container text-tertiary-container-fg",
                      )}
                    >
                      {it.source}
                    </span>
                    <span
                      className={cn(
                        BADGE_BASE,
                        "bg-primary-container text-primary-container-fg",
                      )}
                    >
                      昇格候補
                    </span>
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
            {selected.source} · 昇格候補
          </span>
          <span className="text-sm text-on-surface-variant">
            自動抽出元：{selected.source} · 信頼度{" "}
            {selected.confidence.toFixed(2)}
          </span>
        </div>

        {/* meta row */}
        <div className="grid grid-cols-2 gap-4 border-b border-border bg-surface-variant px-8 py-4 sm:grid-cols-3">
          <div>
            <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-on-surface-variant">
              昇格先
            </div>
            <div className="text-[13px] font-semibold text-on-surface">
              common（共通ナレッジ）
            </div>
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
                className={cn(
                  "text-[13px] tabular-nums",
                  selectedTone.text,
                )}
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
        <div className="flex-1 overflow-y-auto px-8 py-7">
          <div className="mb-5 flex items-start gap-2.5 rounded-md bg-tertiary-container px-4 py-3 text-[12.5px] text-tertiary-container-fg">
            <span aria-hidden className="mt-px font-bold">
              ✦
            </span>
            <div>
              <strong>自動抽出（{selected.source}）：</strong>
              <p className="mt-1">
                類似パターンを検出しました。共通ナレッジへの昇格を提案します。確認後に採用してください。
              </p>
            </div>
          </div>

          <input
            readOnly
            value={selected.title}
            aria-label="昇格候補タイトル"
            className="mb-4 w-full border-none bg-transparent text-[26px] font-bold leading-tight tracking-tight text-on-surface outline-none"
          />

          <div className="whitespace-pre-wrap rounded-md border border-border bg-white px-6 py-5 text-sm leading-relaxed text-on-surface">
            {selected.content}
          </div>
        </div>

        {/* actions */}
        <div className="flex flex-wrap items-center gap-3 border-t border-border bg-white px-8 py-4">
          <button
            type="button"
            onClick={() => onApprove(selected.id)}
            aria-label={`${selected.title} を昇格`}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <span aria-hidden>✓</span>
            採用して書込
          </button>
          <button
            type="button"
            onClick={() => onReject(selected.id)}
            aria-label={`${selected.title} を却下`}
            className="inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold text-on-surface transition-colors hover:bg-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            却下
          </button>
          <span
            aria-label={`信頼度 ${pct(selected.confidence)}`}
            className="ml-auto text-sm text-on-surface-variant"
          >
            採用後、Voyage AI で埋め込み生成 → pgvector に保存されます
          </span>
        </div>
      </div>
    </section>
  );
}
