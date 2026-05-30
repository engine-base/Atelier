/**
 * TopBar — T-US-01 (AppShell の上部バー)
 *
 * - 左端: collapsed トグル / アプリ名
 * - 中央: WorkspacePicker + ProjectPicker (T-US-02、children として注入で疎結合化)
 * - 右端: 通知ベル / ユーザーメニュー (T-US-07/09 で完成、ここでは slot として受ける)
 *
 * 全コンポーネントは presentational — state は親(AppShell or ページ) から prop で受ける。
 */

'use client';

import * as React from 'react';
import { Menu as MenuIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export interface TopBarProps {
  /** sidebar の collapsed 状態を切り替えるコールバック */
  readonly onToggleSidebar?: () => void;
  /** 中央 slot (WS/Project picker 等) */
  readonly children?: ReactNode;
  /** 右端 slot (通知ベル/ユーザーメニュー) */
  readonly trailing?: ReactNode;
  readonly className?: string;
}

export function TopBar({ onToggleSidebar, children, trailing, className }: TopBarProps) {
  return (
    <header
      role="banner"
      className={cn(
        'sticky top-0 z-sticky flex h-14 items-center gap-md border-b border-surface-variant bg-surface/95 px-md backdrop-blur',
        className,
      )}
      style={{ zIndex: 'var(--z-sticky)' as unknown as number }}
    >
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={t('a11y.menuOpen')}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-on-surface hover:bg-surface-variant"
      >
        <MenuIcon size={20} aria-hidden="true" />
      </button>

      <div className="text-headline-md font-bold text-on-surface" aria-label={t('common.appName')}>
        {t('common.appName')}
      </div>

      <div className="flex flex-1 items-center justify-center gap-sm">{children}</div>

      <div className="flex items-center gap-sm">{trailing}</div>
    </header>
  );
}
