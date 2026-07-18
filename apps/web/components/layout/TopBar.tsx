/**
 * TopBar — AppShell の上部バー (F-VIS: モック topbar 忠実化)
 *
 * モック 06_mockups/_shared/atelier.css .topbar に準拠:
 *   左端 = ワークスペースピッカー pill [A ENGINE BASE ▾] + "/" + パンくず(現在セクション)
 *   右端 = ユーザーアバター等 (slot)
 *
 * ピッカーは実機能: workspaces + onSelectWorkspace が渡された場合のみ
 * ドロップダウン (listbox) を開閉できる button として描画する。
 * ハンドラ未配線時は非インタラクティブな div (死にボタンを絶対に置かない — Rule 10)。
 */

'use client';

import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Menu } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

export interface WorkspaceLite {
  readonly id: string;
  readonly name: string;
}

export interface TopBarProps {
  /** サイドバー折り畳みトグル (任意・未使用でも後方互換のため受ける) */
  readonly onToggleSidebar?: () => void;
  /** ワークスペース名 (ピッカー pill 表示) */
  readonly workspaceName?: string;
  /** 所属ワークスペース一覧 (onSelectWorkspace と揃って渡すとピッカーが開閉可能になる) */
  readonly workspaces?: readonly WorkspaceLite[];
  /** 現在選択中のワークスペース id */
  readonly currentWorkspaceId?: string;
  /** ワークスペース選択 (localStorage 永続は呼び出し側の責務) */
  readonly onSelectWorkspace?: (id: string) => void;
  /** パンくずの末尾ラベル (現在セクション名) */
  readonly breadcrumb?: string;
  /** 右端 slot (ユーザーメニュー等) */
  readonly trailing?: ReactNode;
  readonly className?: string;
}

const PILL_CLASS =
  'inline-flex items-center gap-2 rounded-md bg-surface-variant px-2.5 py-1.5 text-label-md font-semibold text-on-surface';

function PillBody({ label }: { readonly label: string }) {
  const initial = label.charAt(0).toUpperCase() || 'A';
  return (
    <>
      <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-primary text-[11px] font-bold text-on-primary">
        {initial}
      </span>
      <span className="max-w-[160px] truncate">{label}</span>
    </>
  );
}

/** ワークスペースピッカー (実 dropdown)。外側クリック / Escape で閉じる。 */
function WorkspacePicker({
  label,
  workspaces,
  currentWorkspaceId,
  onSelectWorkspace,
}: {
  readonly label: string;
  readonly workspaces: readonly WorkspaceLite[];
  readonly currentWorkspaceId?: string;
  readonly onSelectWorkspace: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={`ワークスペース: ${label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(PILL_CLASS, 'transition-colors hover:bg-surface-variant/70')}
      >
        <PillBody label={label} />
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-on-surface-variant transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul
          role="listbox"
          aria-label="ワークスペースを選択"
          className="absolute left-0 top-[calc(100%+6px)] z-[200] min-w-[220px] rounded-md border border-border bg-white py-1 shadow-lg"
        >
          {workspaces.map((w) => {
            const selected = w.id === currentWorkspaceId;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onSelectWorkspace(w.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-body-sm text-on-surface hover:bg-surface-variant"
                >
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-primary text-[11px] font-bold text-on-primary">
                    {w.name.charAt(0).toUpperCase() || 'A'}
                  </span>
                  <span className="flex-1 truncate">{w.name}</span>
                  {selected ? (
                    <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function TopBar({
  onToggleSidebar,
  workspaceName,
  workspaces,
  currentWorkspaceId,
  onSelectWorkspace,
  breadcrumb,
  trailing,
  className,
}: TopBarProps) {
  const wsLabel = workspaceName ?? 'ワークスペース';
  const interactive = Boolean(onSelectWorkspace && workspaces && workspaces.length > 0);

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
        {/* ワークスペースピッカー pill (切替ハンドラ未配線時は非インタラクティブ表示) */}
        {interactive ? (
          <WorkspacePicker
            label={wsLabel}
            workspaces={workspaces!}
            currentWorkspaceId={currentWorkspaceId}
            onSelectWorkspace={onSelectWorkspace!}
          />
        ) : (
          <div className={PILL_CLASS} aria-label={`ワークスペース: ${wsLabel}`}>
            <PillBody label={wsLabel} />
          </div>
        )}

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
