/**
 * Dialog — T-US-08 (Modal)
 *
 * - role="dialog" + aria-modal="true" + aria-labelledby (Title 必須)
 * - 開状態で createFocusTrap(T-US-13) を発火、close 時に release + opener へ focus 復帰
 * - Esc キーで close、背景 click でも close (controlled、デフォルト true)
 * - z-modal で TopBar より上、scroll lock(html.overflow=hidden)
 */

'use client';

import * as React from 'react';
import { type ReactNode, useEffect, useId, useRef } from 'react';

import { createFocusTrap } from '../../lib/a11y';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** タイトル (aria-labelledby と表示の両方に使う) */
  readonly title: string;
  readonly children: ReactNode;
  /** フッタ slot (確定/キャンセル等) */
  readonly footer?: ReactNode;
  /** 背景 click で閉じるか (default: true) */
  readonly closeOnOverlay?: boolean;
  readonly className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  closeOnOverlay = true,
  className,
}: DialogProps) {
  const titleId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = (document.activeElement as HTMLElement | null) ?? null;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);

    let trap: { release: () => void } | null = null;
    if (contentRef.current) {
      trap = createFocusTrap(contentRef.current);
      // 初期 focus を dialog 内最初の focusable へ
      const firstFocusable = contentRef.current.querySelector<HTMLElement>(
        'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])',
      );
      firstFocusable?.focus();
    }

    return () => {
      document.removeEventListener('keydown', onKey);
      html.style.overflow = prevOverflow;
      trap?.release();
      openerRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={closeOnOverlay ? onClose : undefined}
      style={{ zIndex: 'var(--z-modal)' as unknown as number }}
      className="fixed inset-0 flex items-center justify-center bg-on-surface/40 p-md"
    >
      <div
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'w-full max-w-md rounded-lg bg-surface text-on-surface shadow-[var(--shadow-e4)]',
          className,
        )}
      >
        <header className="flex items-center justify-between border-b border-surface-variant px-md py-sm">
          <h2 id={titleId} className="text-headline-md font-bold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant"
          >
            ×
          </button>
        </header>
        <div className="px-md py-md">{children}</div>
        {footer ? (
          <footer className="flex justify-end gap-sm border-t border-surface-variant px-md py-sm">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
