/**
 * Notifications (通知ベル) — T-US-07
 *
 * - bell アイコン + 未読 badge
 * - クリックで dropdown panel に未読通知 list を表示
 * - panel 開閉は aria-expanded / role=region
 * - 未読カウントは aria-label に含めて SR にも伝える
 */

'use client';

import * as React from 'react';
import { Bell } from 'lucide-react';
import { useState } from 'react';

import { type Notification } from '../lib/realtime';
import { t } from '../lib/i18n';
import { cn } from '../lib/cn';

export interface NotificationsProps {
  readonly items: readonly Notification[];
  readonly onClear?: () => void;
  readonly className?: string;
}

export function Notifications({ items, onClear, className }: NotificationsProps) {
  const [open, setOpen] = useState(false);
  const unread = items.length;
  const a11yLabel = unread === 0 ? '通知なし' : `未読通知 ${unread} 件`;

  return (
    <div className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={a11yLabel}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-on-surface hover:bg-surface-variant"
      >
        <Bell size={20} aria-hidden="true" />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-label-sm font-semibold text-error-fg"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="region"
          aria-label={a11yLabel}
          style={{ zIndex: 'var(--z-overlay)' as unknown as number }}
          className="absolute right-0 top-full mt-xs w-80 rounded-md border border-surface-variant bg-surface text-on-surface shadow-[var(--shadow-e3)]"
        >
          <header className="flex items-center justify-between border-b border-surface-variant px-md py-sm">
            <span className="text-label-lg font-semibold">{t('nav.approvals')}</span>
            {onClear ? (
              <button
                type="button"
                onClick={onClear}
                className="text-label-md text-primary hover:underline"
              >
                {t('common.close')}
              </button>
            ) : null}
          </header>
          {items.length === 0 ? (
            <div className="px-md py-md text-label-md text-on-surface-variant">—</div>
          ) : (
            <ul role="list" className="max-h-80 overflow-y-auto">
              {items.map((n) => (
                <li
                  key={n.id}
                  className={cn(
                    'border-b border-surface-variant/50 px-md py-sm last:border-b-0',
                    n.level === 'error' && 'bg-error/5',
                    n.level === 'success' && 'bg-tertiary-container/30',
                  )}
                >
                  <p className="text-body-sm">{n.message}</p>
                  <time className="text-label-sm text-on-surface-variant">{n.createdAt}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
