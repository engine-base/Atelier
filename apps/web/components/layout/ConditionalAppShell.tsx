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
import { useEffect, useState, type ReactNode } from 'react';
import {
  Bell,
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

import { getJson } from '../../lib/auth/connector';
import { AppShell } from './AppShell';
import type { NavItem } from './Sidebar';

const ICON = 'h-4 w-4';

/** モック appshell.js のワークスペース系ナビに準拠 (labelKey は literal ラベル: t() 未登録キーは自身を返す)。 */
// href は各セクションの主画面の実ルート (index ルートは存在しないため子ルートを直指定)。
// match はセクション prefix — sub-route (例 /projects/dashboard) でも active になるようにする。
const MAIN_NAV: readonly NavItem[] = [
  { id: 'projects', labelKey: 'プロジェクト', href: '/projects', match: '/projects', icon: <FolderKanban className={ICON} /> },
  { id: 'employees', labelKey: 'AI社員', href: '/employees', match: '/employees', icon: <Users className={ICON} /> },
  { id: 'chat', labelKey: 'チャット', href: '/chat', match: '/chat', icon: <MessageSquare className={ICON} /> },
  { id: 'tasks', labelKey: 'タスク', href: '/tasks', match: '/tasks', icon: <Bot className={ICON} /> },
  { id: 'workflow', labelKey: '工程', href: '/workflow', match: '/workflow', icon: <Workflow className={ICON} /> },
  { id: 'knowledge', labelKey: 'ナレッジ', href: '/knowledge', match: '/knowledge', icon: <Brain className={ICON} /> },
  { id: 'approvals', labelKey: '承認待ち', href: '/approvals', match: '/approvals', icon: <Inbox className={ICON} /> },
  { id: 'meetings', labelKey: '議事録', href: '/meetings', match: '/upload', icon: <FileText className={ICON} /> },
  { id: 'ws-settings', labelKey: 'WS設定', href: '/workspace-settings', match: '/workspace-settings', icon: <Settings className={ICON} /> },
];

/**
 * 主 AppShell を付けない意味的パス。URL 是正で pathname は意味的URL(/signin 等)になったため
 * 旧 内部prefix(/auth /client…) 判定では signin 等に誤ってシェルが付いていた。
 *   - auth / landing / 法務ページ / デモ : 単体ページ (シェル不要)
 *   - /admin/* : 専用 AdminShell を持つ
 *   - 外部クライアントポータル(/portal, /portal/signin) : 専用 ClientShell / サインイン単体
 * 社内向けの招待管理(/portal/invitations)と WS設定(/workspace-settings)はモック通り主シェルを付ける。
 */
const BARE_EXACT: ReadonlySet<string> = new Set(['/', '/signin', '/signup']);
const BARE_PREFIXES: readonly string[] = [
  '/admin',
  '/terms',
  '/privacy',
  '/tokushoho',
  '/data-deletion',
  '/t-uc',
];

function isBare(pathname: string): boolean {
  if (BARE_EXACT.has(pathname)) return true;
  if (BARE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true;
  // 外部クライアントポータルはベア。社内向け招待管理のみ主シェルを付ける。
  if (pathname === '/portal' || pathname.startsWith('/portal/')) {
    return !(pathname === '/portal/invitations' || pathname.startsWith('/portal/invitations/'));
  }
  return false;
}

interface WorkspaceLite {
  readonly id: string;
  readonly name: string;
}

/** トップバー右端: 通知ベル + ユーザーアバター (モックのトップバー右側)。 */
function TopBarTrailing() {
  return (
    <>
      <button
        type="button"
        aria-label="通知"
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-variant"
      >
        <Bell className="h-5 w-5" aria-hidden="true" />
      </button>
      <span
        aria-hidden="true"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-variant text-label-md font-semibold text-on-surface-variant"
      >
        Q
      </span>
    </>
  );
}

export function ConditionalAppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const bare = isBare(pathname);
  const [workspaceName, setWorkspaceName] = useState<string | undefined>();

  useEffect(() => {
    if (bare) return;
    let cancelled = false;
    getJson<readonly WorkspaceLite[]>('/workspaces')
      .then((res) => {
        if (!cancelled) setWorkspaceName(res.data[0]?.name);
      })
      .catch(() => {
        /* シェル表示は WS 名取得失敗でも継続 */
      });
    return () => {
      cancelled = true;
    };
  }, [bare]);

  if (bare) return <>{children}</>;
  return (
    <AppShell
      currentPath={pathname}
      navItems={MAIN_NAV}
      workspaceName={workspaceName}
      topBarTrailing={<TopBarTrailing />}
    >
      {children}
    </AppShell>
  );
}
