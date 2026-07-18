/**
 * Sidebar — T-US-01 (AppShell の左サイドバー)
 *
 * - モック 06_mockups/_shared/appshell.js の正準ナビに準拠:
 *   「ワークスペース · <ws>」「プロジェクト · <project>」のセクション構造で描画する
 * - i18n (T-US-12) の nav.* キーで項目ラベルを引く (literal ラベルも可)
 * - collapsed/expanded 状態は親(AppShell) から prop で制御 (controlled component)
 * - レスポンシブ: lg 未満では AppShell がオフキャンバスドロワーとして描画する
 * - WCAG 2.2 AA: aria-label / current-page マーク / キーボード遷移を保証
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

/** モック appshell.js の nav-section に対応するセクション。 */
export interface NavSection {
  readonly id: string;
  /** セクション見出し (例: "ワークスペース · ENGINE BASE") */
  readonly label: string;
  readonly items: readonly NavItem[];
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
  /** ナビ項目を上書きしたい場合 (sections 未指定時の単一セクション) */
  readonly items?: readonly NavItem[];
  /** セクション構造ナビ (指定時は items より優先) */
  readonly sections?: readonly NavSection[];
  /** 折りたたみ状態 */
  readonly collapsed?: boolean;
  /** サイドバー上部に出すワークスペース名 (モックの「ワークスペース · <name>」) */
  readonly workspaceName?: string;
  /** リンク遷移時に呼ぶ (モバイルドロワーを閉じる用) */
  readonly onNavigate?: () => void;
  /** className 追加 */
  readonly className?: string;
}

/** href が currentPath にマッチするか (完全一致 or prefix で sub-route 扱い) */
export function isCurrent(href: string, currentPath: string | undefined): boolean {
  if (!currentPath) return false;
  if (href === '/') return currentPath === '/';
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

function NavLink({
  item,
  currentPath,
  collapsed,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly currentPath?: string;
  readonly collapsed: boolean;
  readonly onNavigate?: () => void;
}) {
  const current = isCurrent(item.match ?? item.href, currentPath);
  return (
    <Link
      href={item.href}
      aria-current={current ? 'page' : undefined}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-sm rounded-md px-sm py-[7px] text-[13px] font-medium text-on-surface transition-colors',
        'hover:bg-surface-variant',
        current && 'bg-primary-container font-semibold text-on-primary-container',
      )}
    >
      {item.icon ? (
        <span aria-hidden="true" className="shrink-0">
          {item.icon}
        </span>
      ) : null}
      {collapsed ? null : <span className="truncate">{t(item.labelKey)}</span>}
    </Link>
  );
}

export function Sidebar({
  currentPath,
  items = DEFAULT_NAV_ITEMS,
  sections,
  collapsed = false,
  workspaceName,
  onNavigate,
  className,
}: SidebarProps) {
  const resolvedSections: readonly NavSection[] =
    sections ??
    ([
      {
        id: 'main',
        label: workspaceName ? `ワークスペース · ${workspaceName}` : '',
        items,
      },
    ] as const);

  return (
    <nav
      aria-label={t('nav.home')}
      className={cn(
        'flex h-full flex-col border-r border-border bg-white transition-all duration-200',
        collapsed ? 'w-16' : 'w-60',
        className,
      )}
    >
      {/* ロゴ (モック .sidebar-brand: 白地 + border-b) */}
      <div
        className={cn(
          'flex items-center gap-sm border-b border-border px-[18px] pb-[18px] pt-5',
          collapsed && 'justify-center px-0',
        )}
      >
        <span
          aria-hidden="true"
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-[14px] font-bold text-on-primary"
        >
          A
        </span>
        {collapsed ? null : (
          <span className="text-[16px] font-bold tracking-[-0.01em] text-on-surface">
            {t('common.appName')}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto pb-lg">
        {resolvedSections.map((section) => (
          <div key={section.id} className="px-sm pt-[18px]">
            {!collapsed && section.label ? (
              <div className="px-sm pb-2 text-[10.5px] font-bold uppercase tracking-[0.08em] text-on-surface-variant">
                {section.label}
              </div>
            ) : null}
            <ul className="flex flex-col gap-[2px]" role="list">
              {section.items.map((item) => (
                <li key={item.id}>
                  <NavLink
                    item={item}
                    currentPath={currentPath}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
