/**
 * AppShell — T-US-01 (Sidebar + TopBar + main を組み合わせる全ページ用フレーム)
 *
 * - 認証必須エリアの全ページで使う想定
 * - Sidebar/TopBar 自体は presentational、AppShell が collapse 状態を保持
 * - skip-to-content リンクで a11y キーボード操作を保証 (WCAG 2.2 AA)
 * - design tokens: surface 系背景、focus-visible は global tokens.css
 */

'use client';

import * as React from 'react';
import { type ReactNode, useState } from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import { Sidebar, type NavItem } from './Sidebar';
import { TopBar } from './TopBar';

export interface AppShellProps {
  /** main 領域に出すコンテンツ */
  readonly children: ReactNode;
  /** 現在のパス (Sidebar current-page マーク用) */
  readonly currentPath?: string;
  /** カスタム nav 項目 */
  readonly navItems?: readonly NavItem[];
  /** サイドバー上部のワークスペース名 */
  readonly workspaceName?: string;
  /** TopBar のパンくず末尾ラベル (現在セクション名) */
  readonly breadcrumb?: string;
  /** TopBar 右端 slot (通知/ユーザー) */
  readonly topBarTrailing?: ReactNode;
  readonly className?: string;
}

export function AppShell({
  children,
  currentPath,
  navItems,
  workspaceName,
  breadcrumb,
  topBarTrailing,
  className,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={cn('flex min-h-dvh w-full bg-surface text-on-surface', className)}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-toast focus:rounded-md focus:bg-primary focus:px-md focus:py-xs focus:text-primary-fg"
      >
        {t('a11y.skipToContent')}
      </a>
      <Sidebar
        currentPath={currentPath}
        items={navItems}
        collapsed={collapsed}
        workspaceName={workspaceName}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onToggleSidebar={() => setCollapsed((c) => !c)}
          workspaceName={workspaceName}
          breadcrumb={breadcrumb}
          trailing={topBarTrailing}
        />
        <main id="main-content" tabIndex={-1} className="flex-1 px-lg py-lg">
          {children}
        </main>
      </div>
    </div>
  );
}
