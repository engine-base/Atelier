/**
 * Toast — T-US-08 (non-modal 通知)
 *
 * - aria-live=polite (緊急時は assertive) で SR にもアナウンス
 * - 表示時間経過で自動 close (default 4s)、close も手動可
 * - 単発の Toast コンポーネント(複数管理は ToastQueue で行う想定)
 * - z-toast で最上位
 */

'use client';

import * as React from 'react';
import { useEffect } from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export type ToastTone = 'info' | 'success' | 'error';

export interface ToastProps {
  readonly id: string;
  readonly message: string;
  readonly tone?: ToastTone;
  readonly durationMs?: number;
  readonly onClose: (id: string) => void;
  readonly className?: string;
}

const TONE_STYLES: Record<ToastTone, string> = {
  info: 'bg-surface text-on-surface border-surface-variant',
  success: 'bg-tertiary-container text-tertiary-container-fg border-tertiary',
  error: 'bg-error text-error-fg border-error',
};

export function Toast({
  id,
  message,
  tone = 'info',
  durationMs = 4000,
  onClose,
  className,
}: ToastProps) {
  useEffect(() => {
    if (durationMs <= 0) return;
    const tm = setTimeout(() => onClose(id), durationMs);
    return () => clearTimeout(tm);
  }, [id, durationMs, onClose]);

  return (
    <div
      role="status"
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
      style={{ zIndex: 'var(--z-toast)' as unknown as number }}
      className={cn(
        'flex items-center justify-between gap-md rounded-md border px-md py-sm shadow-[var(--shadow-e3)]',
        TONE_STYLES[tone],
        className,
      )}
    >
      <span className="text-body-md">{message}</span>
      <button
        type="button"
        onClick={() => onClose(id)}
        aria-label={t('common.close')}
        className="inline-flex h-6 w-6 items-center justify-center rounded-sm hover:bg-on-surface/10"
      >
        ×
      </button>
    </div>
  );
}
