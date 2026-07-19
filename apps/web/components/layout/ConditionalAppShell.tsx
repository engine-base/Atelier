/**
 * ConditionalAppShell — F-VIS-01 是正: メインアプリ全ルートに AppShell(Sidebar+TopBar) を配線する。
 *
 * ナビは 06_mockups/_shared/appshell.js の正準構造に準拠:
 *   - 「ワークスペース · <ws>」: プロジェクト / AI社員 / ナレッジ / 承認待ち / WS設定
 *   - 「プロジェクト · <name>」: ダッシュボード / 工程 / タスク / チャット / 議事録 / シークレット / 設定
 *     (現在プロジェクト = useProjectId と同じ localStorage 永続値。未選択時は非表示)
 *
 * パスに応じて shell を適用/除外する:
 *   - /signin, /signup, /admin, 法務ページ, /portal, /t-uc-* : 自前 shell or shell 不要 → bare
 *   - それ以外 (/projects, /chat, /workflow ...) : AppShell を適用
 */

'use client';

import * as React from 'react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Brain,
  Clock,
  FileText,
  Folder,
  Inbox,
  Kanban,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Users,
  Workflow,
} from 'lucide-react';
import { usePathname } from 'next/navigation';

import { getJson } from '../../lib/auth/connector';
import {
  readCurrentWorkspace,
  writeCurrentWorkspace,
} from '../../lib/currentWorkspace';
import { CURRENT_PROJECT_KEY } from '../../lib/useProjectId';
import { AppShell } from './AppShell';
import type { NavItem, NavSection } from './Sidebar';

const ICON = 'h-4 w-4';

/** モック appshell.js GLOBAL 準拠 (labelKey は literal ラベル: t() 未登録キーは自身を返す)。 */
const WS_NAV: readonly NavItem[] = [
  { id: 'projects', labelKey: 'プロジェクト', href: '/projects', match: '/projects', icon: <Folder className={ICON} /> },
  { id: 'employees', labelKey: 'AI社員', href: '/employees', match: '/employees', icon: <Users className={ICON} /> },
  { id: 'knowledge', labelKey: 'ナレッジ', href: '/knowledge', match: '/knowledge', icon: <Brain className={ICON} /> },
  { id: 'approvals', labelKey: '承認待ち', href: '/approvals', match: '/approvals', icon: <Inbox className={ICON} /> },
  { id: 'ws-settings', labelKey: 'WS設定', href: '/workspace-settings', match: '/workspace-settings', icon: <Settings className={ICON} /> },
];

/** モック appshell.js PROJECT 準拠。href に ?project= を付与して project 文脈を保持する。 */
function projectNav(projectId: string): readonly NavItem[] {
  const q = `?project=${projectId}`;
  return [
    { id: 'p-dashboard', labelKey: 'ダッシュボード', href: `/projects/dashboard${q}`, match: '/projects/dashboard', icon: <LayoutDashboard className={ICON} /> },
    { id: 'p-workflow', labelKey: '工程', href: `/workflow${q}`, match: '/workflow', icon: <Workflow className={ICON} /> },
    { id: 'p-tasks', labelKey: 'タスク', href: `/tasks${q}`, match: '/tasks', icon: <Kanban className={ICON} /> },
    { id: 'p-chat', labelKey: 'チャット', href: `/chat${q}`, match: '/chat', icon: <MessageSquare className={ICON} /> },
    { id: 'p-meetings', labelKey: '議事録', href: `/meetings${q}`, match: '/meetings', icon: <FileText className={ICON} /> },
    // モック appshell.js には無いが、S-O01 への UI 導線が皆無 (到達不能画面) だったため追加
    { id: 'p-schedules', labelKey: 'スケジュール', href: `/schedules${q}`, match: '/schedules', icon: <Clock className={ICON} /> },
    { id: 'p-vault', labelKey: 'シークレット', href: `/projects/vault${q}`, match: '/projects/vault', icon: <KeyRound className={ICON} /> },
    { id: 'p-settings', labelKey: '設定', href: `/projects/settings${q}`, match: '/projects/settings', icon: <Settings className={ICON} /> },
  ];
}

/** プロジェクト文脈のセクション判定: PROJECT nav の match に一致するパスでは
 * ワークスペース側の同名セクション (tasks/workflow/chat 等) より project 側を active にする。 */
const BARE_EXACT: ReadonlySet<string> = new Set(['/', '/signin', '/signup']);
const BARE_PREFIXES: readonly string[] = [
  '/admin',
  '/terms',
  '/privacy',
  '/tokushoho',
  '/data-deletion',
  '/t-uc',
];

/** main の既定 padding を外すフルブリード画面 (自前でヘッダー/余白を持つ)。 */
const FULL_BLEED_PREFIXES: readonly string[] = ['/workflow', '/chat'];

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

interface ProjectLite {
  readonly id: string;
  readonly name: string;
}

interface MeLite {
  readonly display_name?: string | null;
  readonly email?: string | null;
}

/** トップバー右端: ユーザーアバター (GET /me の実プロフィール)。
 * 通知ベルは通知 API が存在しないため撤去 (Rule 10 / GAP-007)。 */
function TopBarTrailing({ me }: { readonly me?: MeLite }) {
  const label = me?.display_name || me?.email || undefined;
  if (!label) return null;
  return (
    <span
      role="img"
      aria-label={`サインイン中: ${label}`}
      title={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-variant text-label-md font-semibold text-on-surface-variant"
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}

export function ConditionalAppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname() ?? '/';
  const bare = isBare(pathname);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceLite[]>([]);
  const [currentWsId, setCurrentWsId] = useState<string | undefined>();
  const [me, setMe] = useState<MeLite | undefined>();
  const [project, setProject] = useState<ProjectLite | undefined>();

  useEffect(() => {
    if (bare) return;
    let cancelled = false;
    getJson<readonly WorkspaceLite[]>('/workspaces')
      .then((res) => {
        if (cancelled) return;
        setWorkspaces(res.data);
        // 現在 WS: localStorage 永続値 (T-UC-38 と同一キー) → 先頭フォールバック
        const saved = readCurrentWorkspace();
        const valid = res.data.find((w) => w.id === saved);
        setCurrentWsId((valid ?? res.data[0])?.id);
      })
      .catch(() => {
        /* シェル表示は WS 名取得失敗でも継続 */
      });
    getJson<MeLite>('/me')
      .then((res) => {
        if (!cancelled) setMe(res.data);
      })
      .catch(() => {
        /* アバターはプロフィール取得失敗時は出さない */
      });
    return () => {
      cancelled = true;
    };
  }, [bare]);

  // 現在プロジェクト (useProjectId と同じ永続値 + URL ?project= 優先) の名前を引く。
  useEffect(() => {
    if (bare || typeof window === 'undefined') return;
    const fromUrl = new URLSearchParams(window.location.search).get('project');
    const id = fromUrl ?? window.localStorage.getItem(CURRENT_PROJECT_KEY);
    if (!id) {
      setProject(undefined);
      return;
    }
    let cancelled = false;
    getJson<ProjectLite>(`/projects/${id}`)
      .then((res) => {
        if (!cancelled) setProject({ id, name: res.data.name });
      })
      .catch(() => {
        if (!cancelled) setProject(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [bare, pathname]);

  if (bare) return <>{children}</>;

  const workspaceName = workspaces.find((w) => w.id === currentWsId)?.name;
  const sections: NavSection[] = [
    {
      id: 'workspace',
      label: `ワークスペース · ${workspaceName ?? '…'}`,
      items: WS_NAV,
    },
  ];
  if (project) {
    sections.push({
      id: 'project',
      label: `プロジェクト · ${project.name}`,
      items: projectNav(project.id),
    });
  }

  const allNav = sections.flatMap((s) => s.items);
  const activeNav = allNav.find(
    (n) => pathname === n.match || pathname.startsWith(`${n.match}/`),
  );
  const fullBleed = FULL_BLEED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );

  return (
    <AppShell
      currentPath={pathname}
      navSections={sections}
      workspaceName={workspaceName}
      workspaces={workspaces}
      currentWorkspaceId={currentWsId}
      onSelectWorkspace={(id) => {
        writeCurrentWorkspace(id);
        setCurrentWsId(id);
      }}
      breadcrumb={activeNav?.labelKey}
      topBarTrailing={<TopBarTrailing me={me} />}
      fullBleed={fullBleed}
    >
      {children}
    </AppShell>
  );
}
