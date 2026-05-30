/**
 * S-K02 ナレッジ昇格レビュー — T-UC-19
 *
 * AI 抽出ナレッジを「昇格」(common scope 公開) するか「却下」するかをレビュー。
 * - confidence_score 表示 + before/after preview + approve/reject button
 */

'use client';

import * as React from 'react';

import { cn } from '../../../../lib/cn';

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

export function PromotionReview({ items, onApprove, onReject }: PromotionReviewProps) {
  return (
    <section aria-label="ナレッジ昇格レビュー" className="flex flex-col gap-md">
      {items.length === 0 ? (
        <p className="text-body-md text-on-surface-variant">レビュー対象なし</p>
      ) : (
        <ul role="list" className="flex flex-col gap-md">
          {items.map((it) => (
            <li key={it.id} className="rounded-md border border-surface-variant bg-surface p-md">
              <header className="flex items-baseline justify-between">
                <h3 className="text-label-lg font-semibold text-on-surface">{it.title}</h3>
                <span
                  aria-label={`信頼度 ${(it.confidence * 100).toFixed(0)}%`}
                  className={cn(
                    'text-label-md',
                    it.confidence >= 0.8
                      ? 'text-tertiary'
                      : it.confidence >= 0.5
                        ? 'text-on-surface-variant'
                        : 'text-error',
                  )}
                >
                  信頼度 {(it.confidence * 100).toFixed(0)}%
                </span>
              </header>
              <p className="mt-xs text-label-sm text-on-surface-variant">
                出典: {it.source}
              </p>
              <p className="mt-sm whitespace-pre-wrap text-body-sm text-on-surface">{it.content}</p>
              <footer className="mt-md flex gap-sm">
                <button
                  type="button"
                  onClick={() => onApprove(it.id)}
                  aria-label={`${it.title} を昇格`}
                  className="inline-flex h-9 items-center rounded-md bg-tertiary px-md text-label-md text-tertiary-fg"
                >
                  昇格
                </button>
                <button
                  type="button"
                  onClick={() => onReject(it.id)}
                  aria-label={`${it.title} を却下`}
                  className="inline-flex h-9 items-center rounded-md border border-error px-md text-label-md text-error"
                >
                  却下
                </button>
              </footer>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
