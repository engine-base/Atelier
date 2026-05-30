/**
 * 横断: 通知センター — T-UC-36
 *
 * 全通知の一覧表示 + 既読/未読フィルタ。Notifications コンポーネント (Bundle D) は
 * 通知ベルだったので、ここではフル画面通知センター。
 */

'use client';

import * as React from 'react';
import { useState } from 'react';

import { cn } from '../../lib/cn';

interface NotificationItem {
  readonly id: string;
  readonly level: 'info' | 'success' | 'error';
  readonly message: string;
  readonly read: boolean;
  readonly createdAt: string;
}

const SAMPLE: NotificationItem[] = [
  { id: 'n1', level: 'info', message: 'タスクが承認されました', read: false, createdAt: '5 分前' },
  { id: 'n2', level: 'error', message: '実行に失敗しました', read: true, createdAt: '1 時間前' },
];

const LEVEL_BG = {
  info: 'border-l-surface-variant',
  success: 'border-l-tertiary',
  error: 'border-l-error',
} as const;

export default function UC36Page() {
  const [items, setItems] = useState<NotificationItem[]>(SAMPLE);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  const visible = filter === 'all' ? items : items.filter((n) => !n.read);
  const unreadCount = items.filter((n) => !n.read).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-md px-md py-lg">
      <header className="flex items-center justify-between">
        <h1 className="text-headline-md font-bold text-on-surface">通知センター</h1>
        <span aria-label={`未読 ${unreadCount} 件`} className="text-label-md text-on-surface-variant">
          未読 {unreadCount}
        </span>
      </header>
      <div role="tablist" aria-label="フィルタ" className="flex gap-xs">
        {(['all', 'unread'] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              'inline-flex h-8 items-center rounded-sm px-sm text-label-md',
              filter === f
                ? 'bg-primary text-primary-fg'
                : 'bg-surface-variant text-on-surface',
            )}
          >
            {f === 'all' ? 'すべて' : '未読のみ'}
          </button>
        ))}
      </div>
      <ul role="list" className="flex flex-col gap-sm">
        {visible.length === 0 ? (
          <li className="text-body-md text-on-surface-variant">通知はありません</li>
        ) : (
          visible.map((n) => (
            <li
              key={n.id}
              className={cn(
                'flex items-start justify-between border-l-4 bg-surface px-md py-sm shadow-[var(--shadow-e1)]',
                LEVEL_BG[n.level],
                !n.read && 'font-semibold',
              )}
            >
              <div className="flex flex-col">
                <p className="text-body-sm text-on-surface">{n.message}</p>
                <time className="text-label-sm text-on-surface-variant">{n.createdAt}</time>
              </div>
              {!n.read ? (
                <button
                  type="button"
                  onClick={() =>
                    setItems((it) => it.map((x) => (x.id === n.id ? { ...x, read: true } : x)))
                  }
                  aria-label={`${n.message} を既読にする`}
                  className="inline-flex h-7 items-center rounded-sm border border-surface-variant px-sm text-label-sm"
                >
                  既読
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
