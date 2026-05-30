/**
 * AdminShell — T-US-16 (運営 admin 用ダークレイアウト)
 *
 * 通常の Atelier UI と区別するためダーク系トーン (on-surface を背景に on-surface-fg
 * 反転で文字色) で適用。design tokens は反転ロール (--color-on-surface 等) を
 * 直接使い、別途新規 token は作らない (一貫性維持)。
 */

import * as React from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface AdminShellProps {
  readonly children: ReactNode;
  readonly className?: string;
}

export function AdminShell({ children, className }: AdminShellProps) {
  return (
    <div
      className={cn(
        'flex min-h-dvh w-full flex-col bg-on-surface text-surface',
        className,
      )}
      data-theme="admin-dark"
    >
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-toast focus:rounded-md focus:bg-primary focus:px-md focus:py-xs focus:text-primary-fg"
      >
        メインコンテンツへスキップ
      </a>
      <header
        role="banner"
        className="flex h-14 items-center justify-between border-b border-surface-variant/30 px-lg"
      >
        <span className="text-headline-md font-bold tracking-wide text-surface">
          Atelier Admin
        </span>
        <span className="text-label-md text-surface-variant">運営コンソール</span>
      </header>
      <main id="main-content" tabIndex={-1} className="flex-1 px-lg py-lg">
        {children}
      </main>
    </div>
  );
}
