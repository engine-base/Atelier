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
import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Bell,
  Brain,
  Briefcase,
  Clock,
  FileText,
  Folder,
  Inbox,
  Kanban,
  KeyRound,
  LayoutDashboard,
  MessageSquare,
  MonitorSmartphone,
  Search,
  Settings,
  Users,
  Workflow,
} from 'lucide-react';
import { usePathname } from 'next/navigation';

import { getJson } from '../../lib/auth/connector';
import { ROUTE_MAP } from '../../lib/routes';
import {
  readCurrentWorkspace,
  writeCurrentWorkspace,
} from '../../lib/currentWorkspace';
import { CURRENT_PROJECT_KEY } from '../../lib/useProjectId';
import { AppShell } from './AppShell';
import { PhaseSwitcher } from './PhaseSwitcher';
import type { NavItem, NavSection } from './Sidebar';

const ICON = 'h-4 w-4';

/** モック appshell.js GLOBAL 準拠 (labelKey は literal ラベル: t() 未登録キーは自身を返す)。 */
const WS_NAV: readonly NavItem[] = [
  { id: 'projects', labelKey: 'プロジェクト', href: '/projects', match: '/projects', icon: <Folder className={ICON} /> },
  { id: 'employees', labelKey: 'AI社員', href: '/employees', match: '/employees', icon: <Users className={ICON} /> },
  { id: 'knowledge', labelKey: 'ナレッジ', href: '/knowledge', match: '/knowledge', icon: <Brain className={ICON} /> },
  // GAP-158: 出力デザインテンプレ (クライアント提出 HTML/PDF の見た目の型) の専用タブ
  { id: 'templates', labelKey: 'テンプレート', href: '/templates', match: '/templates', icon: <FileText className={ICON} /> },
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
    { id: 'p-chat', labelKey: '進行', href: `/chat${q}`, match: '/chat', icon: <MessageSquare className={ICON} /> },
    { id: 'p-meetings', labelKey: '議事録', href: `/meetings${q}`, match: '/meetings', icon: <FileText className={ICON} /> },
    // モック appshell.js には無いが、S-O01 への UI 導線が皆無 (到達不能画面) だったため追加
    { id: 'p-schedules', labelKey: 'スケジュール', href: `/schedules${q}`, match: '/schedules', icon: <Clock className={ICON} /> },
    // S-N01 も同型の到達不能画面だった (design-audit で検出) ため追加
    { id: 'p-sales', labelKey: '営業ドラフト', href: `/sales${q}`, match: '/sales', icon: <Briefcase className={ICON} /> },
    // S-H01 も導線ゼロの到達不能画面だった (design-audit で検出) ため追加
    { id: 'p-mocks', labelKey: 'モック', href: `/mocks${q}`, match: '/mocks', icon: <MonitorSmartphone className={ICON} /> },
    { id: 'p-import', labelKey: '取り込み', href: `/import${q}`, match: '/import', icon: <Inbox className={ICON} /> },
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

/**
 * 実ルート (内部タスクID パス) → 意味的URL の逆引き。
 * SSR/プリレンダ時の usePathname は rewrite 先の内部パス (例 /auth/s_a03) を返すが、
 * ブラウザの URL は常に意味的パス (例 /workspace-settings)。この差をそのままにすると
 * aria-current / パンくず / bare 判定がサーバとクライアントで食い違い、
 * hydration mismatch (React #418) になるため、常に意味的パスへ正規化する。
 */
const INTERNAL_TO_CLEAN: ReadonlyMap<string, string> = new Map(
  ROUTE_MAP.map(([clean, internal]) => [internal, clean] as const),
);

interface WorkspaceLite {
  readonly id: string;
  readonly name: string;
  /** GAP-021: ワークスペースアイコン (絵文字/短文字)。null = 頭文字表示 */
  readonly icon?: string | null;
}

interface ProjectLite {
  readonly id: string;
  readonly name: string;
}

interface MeLite {
  readonly display_name?: string | null;
  readonly email?: string | null;
}

/** トップバー右端: 検索 / 通知ベル (承認待ち未処理数 = 実データ) / ユーザーアバター。
 * 通知ベルは通知センター (T-UC-36 = 承認待ち集約) への実リンク。専用通知 API の
 * ドロップダウン化は GAP-007 のまま。アバターはプロフィール (T-UC-37) への実リンク。 */
function TopBarTrailing({
  me,
  pendingCount,
}: {
  readonly me?: MeLite;
  readonly pendingCount: number;
}) {
  const label = me?.display_name || me?.email || undefined;
  return (
    <span className="flex items-center gap-1.5">
      <Link
        href="/t-uc-40"
        aria-label="検索"
        title="検索"
        className="inline-flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-variant"
      >
        <Search className="h-4 w-4" aria-hidden="true" />
      </Link>
      <Link
        href="/t-uc-36"
        aria-label={`通知センター (未処理の承認待ち ${pendingCount} 件)`}
        title="通知センター"
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-variant"
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {pendingCount > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-error px-1 text-[9.5px] font-bold text-white tabular-nums">
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        ) : null}
      </Link>
      {label ? (
        <Link
          href="/t-uc-37"
          aria-label={`プロフィール: ${label}`}
          title={label}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-surface-variant text-label-md font-semibold text-on-surface-variant transition-shadow hover:ring-2 hover:ring-primary-container"
        >
          {label.charAt(0).toUpperCase()}
        </Link>
      ) : null}
    </span>
  );
}

export function ConditionalAppShell({ children }: { readonly children: ReactNode }) {
  const rawPathname = usePathname() ?? '/';
  const pathname = INTERNAL_TO_CLEAN.get(rawPathname) ?? rawPathname;
  const bare = isBare(pathname);
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceLite[]>([]);
  const [currentWsId, setCurrentWsId] = useState<string | undefined>();
  const [me, setMe] = useState<MeLite | undefined>();
  const [project, setProject] = useState<ProjectLite | undefined>();
  const [pendingCount, setPendingCount] = useState(0);

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
    // 通知ベルの未読バッジ = 本人の未処理承認待ち件数 (実データ)。失敗時は 0 のまま。
    getJson<readonly unknown[]>('/approval-inbox?status=pending')
      .then((res) => {
        if (!cancelled) setPendingCount(Array.isArray(res.data) ? res.data.length : 0);
      })
      .catch(() => {
        /* バッジ非表示のまま */
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

  const currentWs = workspaces.find((w) => w.id === currentWsId);
  const workspaceName = currentWs?.name;
  const workspaceIcon = currentWs?.icon ?? null;

  // GAP-117 (経営者指示の IA 変更): 文脈を分離する。
  //   - プロジェクト系画面ではプロジェクト nav のみ + 「WS 全体へ戻る」導線
  //   - WS 系画面では WS nav のみ (プロジェクトを覚えていても混ぜない)
  const projectItems = project ? projectNav(project.id) : [];
  const inProject =
    project !== undefined &&
    projectItems.some((n) => pathname === n.match || pathname.startsWith(`${n.match}/`));

  const sections: NavSection[] = inProject
    ? [
        {
          id: 'workspace-back',
          label: `ワークスペース · ${workspaceName ?? '…'}`,
          items: [
            {
              id: 'back-to-ws',
              labelKey: '← ワークスペース全体へ',
              href: '/projects',
              match: '/__never__',
              icon: <Folder className={ICON} />,
            },
          ],
        },
        {
          id: 'project',
          label: `プロジェクト · ${project!.name}`,
          items: projectItems,
        },
      ]
    : [
        {
          id: 'workspace',
          label: `ワークスペース · ${workspaceName ?? '…'}`,
          items: WS_NAV,
        },
      ];

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
      workspaceIcon={workspaceIcon}
      workspaces={workspaces}
      currentWorkspaceId={currentWsId}
      onSelectWorkspace={(id) => {
        writeCurrentWorkspace(id);
        setCurrentWsId(id);
      }}
      projectName={inProject ? project!.name : undefined}
      projectExtra={
        inProject ? <PhaseSwitcher key={project!.id} projectId={project!.id} /> : undefined
      }
      breadcrumb={activeNav?.labelKey}
      topBarTrailing={<TopBarTrailing me={me} pendingCount={pendingCount} />}
      fullBleed={fullBleed}
    >
      {children}
    </AppShell>
  );
}
