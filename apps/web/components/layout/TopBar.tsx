/**
 * TopBar — AppShell の上部バー (F-VIS: モック topbar 忠実化)
 *
 * モック 06_mockups/_shared/atelier.css .topbar に準拠:
 *   左端 = ワークスペースpiッカー pill [A ENGINE BASE ▾] + "/" + パンくず(現在セクション)
 *   右端 = 通知ベル + ユーザーアバター (slot)
 * 旧実装のハンバーガー + "Atelier" ワードマークはモックに無いため撤去
 * (ブランドはサイドバー上部が担う)。
 *
 * 全コンポーネントは presentational — state は親から prop で受ける。
 */

'use client';

import * as React from 'react';
import { ChevronDown, Menu } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface TopBarProps {
  /** サイドバー折り畳みトグル (任意・未使用でも後方互換のため受ける) */
  readonly onToggleSidebar?: () => void;
  /** ワークスペース名 (ピッカー pill 表示) */
  readonly workspaceName?: string;
  /** パンくずの末尾ラベル (現在セクション名) */
  readonly breadcrumb?: string;
  /** 右端 slot (通知ベル/ユーザーメニュー) */
  readonly trailing?: ReactNode;
  readonly className?: string;
}

export function TopBar({
  onToggleSidebar,
  workspaceName,
  breadcrumb,
  trailing,
  className,
}: TopBarProps) {
  const wsLabel = workspaceName ?? 'ワークスペース';
  const wsInitial = wsLabel.charAt(0).toUpperCase() || 'A';

  return (
    <header
      role="banner"
      className={cn(
        'sticky top-0 z-[100] flex h-14 items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur sm:px-8',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 sm:gap-4">
        {/* モバイル: サイドバードロワー開閉 (lg 以上は常設サイドバーなので非表示) */}
        {onToggleSidebar ? (
          <button
            type="button"
            aria-label="メニュー"
            onClick={onToggleSidebar}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant lg:hidden"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
        ) : null}
        {/* ワークスペースピッカー pill */}
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md bg-surface-variant px-2.5 py-1.5 text-label-md font-semibold text-on-surface transition-colors hover:bg-surface-variant/70"
          aria-label={`ワークスペース: ${wsLabel}`}
        >
          <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-primary text-[11px] font-bold text-on-primary">
            {wsInitial}
          </span>
          <span className="max-w-[160px] truncate">{wsLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 text-on-surface-variant" aria-hidden="true" />
        </button>

        {/* パンくず */}
        {breadcrumb ? (
          <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-on-surface-variant">
            <span aria-hidden="true" className="text-neutral">
              /
            </span>
            <span className="truncate font-medium text-on-surface">{breadcrumb}</span>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">{trailing}</div>
    </header>
  );
}
