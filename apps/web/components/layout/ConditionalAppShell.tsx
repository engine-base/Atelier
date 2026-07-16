/**
 * ConditionalAppShell — F-VIS-01 是正: メインアプリ全ルートに AppShell(Sidebar+TopBar) を配線する。
 *
 * 従来 AppShell はどのルートにも配線されておらず、メイン画面がナビ無しの素コンテンツで
 * 描画されていた (モックは全画面がナビレール+トップバー構成)。root layout から本コンポーネントで
 * 包み、パスに応じて shell を適用/除外する:
 *   - /auth, /client, /admin, /public, /t-uc-* : 自前 shell or shell 不要 → bare
 *   - それ以外 (/, /projects, /chat, /employees ...) : AppShell を適用
 *
 * ナビ項目は 06_mockups/_shared/appshell.js のワークスペース系ナビに準拠。
 */

'use client';

import * as React from 'react';
import type { ReactNode } from 'react';
import {
  Bot,
  Brain,
  FileText,
  FolderKanban,
  Inbox,
  MessageSquare,
  Settings,
  Users,
  Workflow,
} from 'lucide-react';
import { usePathname } from 'next/navigation';

import { AppShell } from './AppShell';
import type { NavItem } from './Sidebar';

const ICON = 'h-4 w-4';

/** モック appshell.js のワークスペース系ナビに準拠 (labelKey は literal ラベル: t() 未登録キーは自身を返す)。 */
// href は各セクションの主画面の実ルート (index ルートは存在しないため子ルートを直指定)。
const MAIN_NAV: readonly NavItem[] = [
  { id: 'projects', labelKey: 'プロジェクト', href: '/projects/s_b01', icon: <FolderKanban className={ICON} /> },
  { id: 'employees', labelKey: 'AI社員', href: '/employees/s_c01', icon: <Users className={ICON} /> },
  { id: 'chat', labelKey: 'チャット', href: '/chat/s_e01', icon: <MessageSquare className={ICON} /> },
  { id: 'tasks', labelKey: 'タスク', href: '/tasks/s_i01', icon: <Bot className={ICON} /> },
  { id: 'workflow', labelKey: '工程', href: '/workflow/s_f01', icon: <Workflow className={ICON} /> },
  { id: 'knowledge', labelKey: 'ナレッジ', href: '/knowledge/s_k01', icon: <Brain className={ICON} /> },
  { id: 'approvals', labelKey: '承認待ち', href: '/approvals/s_j01', icon: <Inbox className={ICON} /> },
  { id: 'meetings', labelKey: '議事録', href: '/upload/s_m01', icon: <FileText className={ICON} /> },
  { id: 'ws-settings', labelKey: 'WS設定', href: '/auth/s_a03', icon: <Settings className={ICON} /> },
];

/** これらの prefix は自前 shell を持つ or shell 不要 (auth/client/admin/public/デモ)。 */
const BARE_PREFIXES = ['/auth', '/client', '/admin', '/public', '/t-uc'];

function isBare(pathname: string): boolean {
  return BARE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(p));
}

export function ConditionalAppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  if (isBare(pathname)) return <>{children}</>;
  return (
    <AppShell currentPath={pathname} navItems={MAIN_NAV}>
      {children}
    </AppShell>
  );
}
