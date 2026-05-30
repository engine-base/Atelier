/**
 * Loading — T-US-17 (全画面/領域ローディング)
 *
 * - Skeleton と組み合わせる「全体待ち」表示
 * - aria-live=polite + role=status で SR にもアナウンス
 * - design tokens: primary color の spinner、motion-reduce 配慮
 */

'use client';

import * as React from 'react';

import { cn } from '../lib/cn';
import { t } from '../lib/i18n';

export interface LoadingProps {
  /** 全画面か領域内か (default: false) */
  readonly fullScreen?: boolean;
  readonly message?: string;
  readonly className?: string;
}

export function Loading({ fullScreen, message, className }: LoadingProps) {
  const label = message ?? t('common.loading');
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        'flex items-center justify-center gap-sm',
        fullScreen ? 'fixed inset-0 z-overlay bg-surface/80' : 'py-md',
        className,
      )}
      style={fullScreen ? { zIndex: 'var(--z-overlay)' as unknown as number } : undefined}
    >
      <span
        aria-hidden="true"
        className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-primary border-r-transparent"
      />
      <span className="text-label-lg text-on-surface-variant">{label}</span>
    </div>
  );
}
