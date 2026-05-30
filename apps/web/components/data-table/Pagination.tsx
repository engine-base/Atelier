/**
 * Pagination — T-US-10 (cursor ベース)
 *
 * - API が next_cursor / prev_cursor を返す前提
 * - 前/次 ボタンのみ (offset 表示はしない、件数表示は別途)
 * - 無効状態は disabled + aria-disabled で SR にも伝える
 */

'use client';

import * as React from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export interface PaginationProps {
  readonly prevCursor: string | null;
  readonly nextCursor: string | null;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  /** 表示用 (例: '12 件 / 全 320 件') */
  readonly summary?: string;
  readonly className?: string;
}

export function Pagination({
  prevCursor,
  nextCursor,
  onPrev,
  onNext,
  summary,
  className,
}: PaginationProps) {
  const prevDisabled = prevCursor === null;
  const nextDisabled = nextCursor === null;
  return (
    <nav
      aria-label="pagination"
      className={cn('flex items-center justify-between gap-md py-sm text-label-md', className)}
    >
      <span className="text-on-surface-variant">{summary ?? ''}</span>
      <div className="flex items-center gap-xs">
        <button
          type="button"
          onClick={onPrev}
          disabled={prevDisabled}
          aria-disabled={prevDisabled}
          className="inline-flex h-8 items-center rounded-md border border-surface-variant px-sm hover:bg-surface-variant disabled:opacity-50"
        >
          {t('common.back')}
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          aria-disabled={nextDisabled}
          className="inline-flex h-8 items-center rounded-md border border-surface-variant px-sm hover:bg-surface-variant disabled:opacity-50"
        >
          {t('common.next')}
        </button>
      </div>
    </nav>
  );
}
