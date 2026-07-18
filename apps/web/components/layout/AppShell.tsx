/**
 * AppShell — T-US-01 (Sidebar + TopBar + main を組み合わせる全ページ用フレーム)
 *
 * - 認証必須エリアの全ページで使う想定
 * - Sidebar/TopBar 自体は presentational、AppShell が collapse/drawer 状態を保持
 * - レスポンシブ: lg 以上は常設サイドバー、lg 未満はオフキャンバスドロワー
 *   (TopBar のハンバーガーで開閉、backdrop クリック / Escape で閉じる)
 * - skip-to-content リンクで a11y キーボード操作を保証 (WCAG 2.2 AA)
 * - design tokens: surface 系背景、focus-visible は global tokens.css
 */

'use client';

import * as React from 'react';
import { type ReactNode, useEffect, useState } from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import { Sidebar, type NavItem, type NavSection } from './Sidebar';
import { TopBar } from './TopBar';

export interface AppShellProps {
  /** main 領域に出すコンテンツ */
  readonly children: ReactNode;
  /** 現在のパス (Sidebar current-page マーク用) */
  readonly currentPath?: string;
  /** カスタム nav 項目 */
  readonly navItems?: readonly NavItem[];
  /** セクション構造ナビ (指定時は navItems より優先) */
  readonly navSections?: readonly NavSection[];
  /** サイドバー上部のワークスペース名 */
  readonly workspaceName?: string;
  /** TopBar のパンくず末尾ラベル (現在セクション名) */
  readonly breadcrumb?: string;
  /** TopBar 右端 slot (通知/ユーザー) */
  readonly topBarTrailing?: ReactNode;
  /** main の既定 padding を外す (S-F01 のようなフルブリード画面用) */
  readonly fullBleed?: boolean;
  readonly className?: string;
}

export function AppShell({
  children,
  currentPath,
  navItems,
  navSections,
  workspaceName,
  breadcrumb,
  topBarTrailing,
  fullBleed = false,
  className,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // ルート遷移やビューポート復帰時にドロワーを閉じる (開きっぱなし事故防止)
  useEffect(() => {
    setDrawerOpen(false);
  }, [currentPath]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const sidebarProps = {
    currentPath,
    items: navItems,
    sections: navSections,
    workspaceName,
  } as const;

  return (
    <div className={cn('flex min-h-dvh w-full bg-surface text-on-surface', className)}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[1200] focus:rounded-md focus:bg-primary focus:px-md focus:py-xs focus:text-on-primary"
      >
        {t('a11y.skipToContent')}
      </a>

      {/* デスクトップ常設サイドバー */}
      <Sidebar {...sidebarProps} collapsed={collapsed} className="sticky top-0 hidden h-dvh shrink-0 lg:flex" />

      {/* モバイル: オフキャンバスドロワー */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-[1000] lg:hidden" role="dialog" aria-modal="true" aria-label="ナビゲーション">
          <button
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/40"
          />
          <Sidebar
            {...sidebarProps}
            collapsed={false}
            onNavigate={() => setDrawerOpen(false)}
            className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] shadow-xl"
          />
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          onToggleSidebar={() => {
            // lg 以上は collapse、lg 未満はドロワー — 呼び出しは同一ボタン
            if (typeof window !== 'undefined' && window.innerWidth < 1024) {
              setDrawerOpen((o) => !o);
            } else {
              setCollapsed((c) => !c);
            }
          }}
          workspaceName={workspaceName}
          breadcrumb={breadcrumb}
          trailing={topBarTrailing}
        />
        <main
          id="main-content"
          tabIndex={-1}
          className={cn('flex-1', fullBleed ? '' : 'px-md py-md sm:px-lg sm:py-lg')}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
