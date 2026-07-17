/**
 * Sidebar — T-US-01 (AppShell の左サイドバー)
 *
 * - i18n (T-US-12) の nav.* キーで項目ラベルを引く
 * - collapsed/expanded 状態は親(AppShell) から prop で制御 (controlled component)
 * - WCAG 2.2 AA: aria-label / current-page マーク / キーボード遷移を保証
 * - design tokens: surface-variant の background、focus-visible は global tokens.css
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export interface NavItem {
  readonly id: string;
  /** i18n key (例: "nav.projects") もしくは literal label */
  readonly labelKey: string;
  readonly href: string;
  /** current-page 判定に使う prefix (省略時は href)。sub-route でもセクションを active にする用。 */
  readonly match?: string;
  /** lucide-react icon の slot。実 icon は呼び出し側で渡す (props 型は ReactNode) */
  readonly icon?: ReactNode;
}

/** Atelier 既定の主ナビ項目セット */
export const DEFAULT_NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', labelKey: 'nav.home', href: '/' },
  { id: 'projects', labelKey: 'nav.projects', href: '/projects' },
  { id: 'tasks', labelKey: 'nav.tasks', href: '/tasks' },
  { id: 'workflow', labelKey: 'nav.workflow', href: '/workflow' },
  { id: 'knowledge', labelKey: 'nav.knowledge', href: '/knowledge' },
  { id: 'meetings', labelKey: 'nav.meetings', href: '/meetings' },
  { id: 'approvals', labelKey: 'nav.approvals', href: '/approvals' },
];

export interface SidebarProps {
  /** 現在のパス (current-page マーク用) */
  readonly currentPath?: string;
  /** ナビ項目を上書きしたい場合 */
  readonly items?: readonly NavItem[];
  /** 折りたたみ状態 */
  readonly collapsed?: boolean;
  /** サイドバー上部に出すワークスペース名 (モックの「ワークスペース · <name>」) */
  readonly workspaceName?: string;
  /** className 追加 */
  readonly className?: string;
}

/** href が currentPath にマッチするか (完全一致 or prefix で sub-route 扱い) */
export function isCurrent(href: string, currentPath: string | undefined): boolean {
  if (!currentPath) return false;
  if (href === '/') return currentPath === '/';
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

export function Sidebar({
  currentPath,
  items = DEFAULT_NAV_ITEMS,
  collapsed = false,
  workspaceName,
  className,
}: SidebarProps) {
  return (
    <nav
      aria-label={t('nav.home')}
      className={cn(
        'flex h-full flex-col gap-xs border-r border-surface-variant bg-surface py-md transition-all duration-200',
        collapsed ? 'w-16' : 'w-64',
        className,
      )}
    >
      {/* ロゴ + ワークスペース名 (モック S-*-list.html の左上ヘッダ) */}
      <div className={cn('flex flex-col gap-xs px-md pb-md', collapsed && 'items-center px-0')}>
        <div className="flex items-center gap-sm">
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-title-md font-black text-primary-fg"
          >
            A
          </span>
          {collapsed ? null : (
            <span className="text-title-md font-bold text-on-surface">
              {t('common.appName')}
            </span>
          )}
        </div>
        {!collapsed && workspaceName ? (
          <span className="truncate pl-1 text-label-sm text-on-surface-variant">
            ワークスペース · {workspaceName}
          </span>
        ) : null}
      </div>

      <ul className="flex flex-col gap-xs px-sm" role="list">
        {items.map((item) => {
          const current = isCurrent(item.match ?? item.href, currentPath);
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-sm rounded-md px-sm py-xs text-label-lg text-on-surface',
                  'hover:bg-surface-variant',
                  current && 'bg-primary-container text-primary-container-fg font-semibold',
                )}
              >
                {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                {collapsed ? null : <span>{t(item.labelKey)}</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
