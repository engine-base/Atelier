/**
 * ClientShell — T-US-15 (クライアントポータル用シンプルレイアウト)
 *
 * 内部ナビは持たず、ヘッダ + main のみ。AppShell より軽量で、外部クライアントが
 * 見る「project 単票」表示用。design tokens は通常通り surface 系。
 */

import * as React from 'react';
import type { ReactNode } from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export interface ClientShellProps {
  readonly children: ReactNode;
  /** ヘッダのプロジェクト名 (表示用、未指定なら appName) */
  readonly projectName?: string;
  /** クライアント表示名 (右端) */
  readonly clientDisplayName?: string;
  readonly className?: string;
}

export function ClientShell({
  children,
  projectName,
  clientDisplayName,
  className,
}: ClientShellProps) {
  return (
    <div className={cn('flex min-h-dvh w-full flex-col bg-surface text-on-surface', className)}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-toast focus:rounded-md focus:bg-primary focus:px-md focus:py-xs focus:text-primary-fg"
      >
        {t('a11y.skipToContent')}
      </a>
      <header
        role="banner"
        className="flex h-14 items-center justify-between border-b border-surface-variant bg-surface px-lg"
      >
        <div className="flex items-center gap-md">
          <span className="text-headline-md font-bold text-on-surface">
            {t('client.portalTitle')}
          </span>
          {projectName ? (
            <span className="text-label-lg text-on-surface-variant" aria-label={projectName}>
              {projectName}
            </span>
          ) : null}
        </div>
        {clientDisplayName ? (
          <div className="text-label-md text-on-surface-variant">{clientDisplayName}</div>
        ) : null}
      </header>
      <main id="main-content" tabIndex={-1} className="flex-1 px-lg py-lg">
        {children}
      </main>
    </div>
  );
}
