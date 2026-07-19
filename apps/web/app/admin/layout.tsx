/**
 * /admin 共通レイアウト — design-audit v2
 *
 * モック 06_mockups/admin/*.html のダーク管理サイドバー (data-context="admin") に準拠。
 * 監査前は各 admin 画面が素のページで、6 画面間の UI 導線がゼロだった (画面内到達不能)。
 * lg 未満はサイドバーを畳み、横スクロールするトップナビ行に切り替える。
 */

'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '../../lib/cn';

interface NavItem {
  readonly href: string;
  readonly match: string;
  readonly exact?: boolean;
  readonly label: string;
}

const NAV: readonly NavItem[] = [
  { href: '/admin', match: '/admin', exact: true, label: '運営ダッシュボード' },
  { href: '/admin/skills', match: '/admin/skills', label: '能力（スキル）' },
  { href: '/admin/templates', match: '/admin/templates', label: 'AI 社員テンプレ' },
  { href: '/admin/users', match: '/admin/users', label: 'ユーザー' },
  { href: '/admin/audit', match: '/admin/audit', label: '監査ログ' },
  { href: '/admin/platform-knowledge', match: '/admin/platform-knowledge', label: '運営ナレッジ' },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.match || pathname === '/admin/s_t01';
  return pathname === item.match || pathname.startsWith(`${item.match}/`);
}

/** 実ルート (s_t0X) で開かれた場合も active 判定できるようにする。 */
const INTERNAL_MATCH: ReadonlyArray<readonly [string, string]> = [
  ['/admin/s_t02', '/admin/skills'],
  ['/admin/s_t03', '/admin/templates'],
  ['/admin/s_t04', '/admin/users'],
  ['/admin/s_t05', '/admin/audit'],
  ['/admin/s_t06', '/admin/platform-knowledge'],
];

export default function AdminLayout({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const rawPath = usePathname() ?? '/admin';
  const pathname =
    INTERNAL_MATCH.find(([internal]) => rawPath.startsWith(internal))?.[1] ??
    rawPath;

  const nav = (
    <nav aria-label="運営メニュー" className="flex flex-col gap-0.5 px-2 py-3">
      <span className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.1em] text-[#475569]">
        Platform Ops
      </span>
      {NAV.map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md border-l-2 border-transparent px-3 py-2 text-[13px] font-medium text-[#94A3B8] transition',
              'hover:bg-white/5 hover:text-[#E2E8F0]',
              active && 'border-primary bg-primary/15 text-[#93C5FD]',
            )}
          >
            {item.label}
          </Link>
        );
      })}
      <Link
        href="/projects"
        className="mt-3 rounded-md px-3 py-2 text-[12px] text-[#64748B] transition hover:bg-white/5 hover:text-[#E2E8F0]"
      >
        ← アプリへ戻る
      </Link>
    </nav>
  );

  return (
    <div className="flex min-h-dvh bg-surface">
      {/* ダーク管理サイドバー (lg 以上) */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[#1E293B] bg-[#0F172A] lg:flex">
        <div className="flex items-center gap-2 border-b border-[#1E293B] px-4 py-4">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-error text-sm font-black text-white">
            A
          </span>
          <div>
            <div className="text-[15px] font-bold leading-tight text-white">
              Atelier
            </div>
            <div className="text-[10px] tracking-[0.1em] text-[#94A3B8]">
              ADMIN CONSOLE
            </div>
          </div>
        </div>
        {nav}
      </aside>

      <div className="min-w-0 flex-1">
        {/* トップバー: 運営タグ + (モバイル) 横スクロールナビ */}
        <header className="border-b border-border bg-white">
          <div className="flex items-center gap-3 px-4 py-2.5 lg:px-6">
            <span className="inline-flex items-center rounded-sm bg-error px-2.5 py-[3px] text-[10px] font-extrabold tracking-[0.08em] text-white">
              運営
            </span>
            <span className="text-[13px] font-semibold text-on-surface">
              {NAV.find((n) => isActive(pathname, n))?.label ?? 'Admin'}
            </span>
            <Link
              href="/projects"
              className="ml-auto text-[12px] text-on-surface-variant transition hover:text-primary lg:hidden"
            >
              ← アプリへ
            </Link>
          </div>
          <nav
            aria-label="運営メニュー (モバイル)"
            className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden"
          >
            {NAV.map((item) => {
              const active = isActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-semibold transition',
                    active
                      ? 'bg-primary-container text-on-primary-container'
                      : 'text-on-surface-variant hover:bg-surface-variant',
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </header>
        {children}
      </div>
    </div>
  );
}
