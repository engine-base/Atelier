/**
 * S-K01 ナレッジエクスプローラ — T-UC-43 (F-023 / F-024)
 *
 * 共通 / AI社員別 / プロジェクト別 の 3 層 scope ツリーを REAL API に配線する。
 *
 *   - ルート取得 : GET /knowledge?account_type=workspace&account_id=<ws>&scope=<scope>&tree_only=true
 *   - 子取得     : GET /knowledge?...&parent_id=<nodeId>   (ノード展開時に遅延取得)
 *   - 作成       : POST /knowledge  (account_type=workspace, scope=現在の scope, source_type=manual)
 *
 * 運営デフォルト(platform)は tree_only=true により visible_in_tree=false が除外され、
 * このツリーには出ない (RAG 参照のみ)。RLS 越境=0 はサーバ側で担保され、UI は member
 * token で API を呼ぶだけ。
 *
 * パネル: 左(ツリー) / 右(詳細) を独立に開閉でき、中央が拡張する (モック panels.js 準拠)。
 * api client は prop 注入可能 (テスト時に fake を渡す)。workspaceId も prop で受け、
 * 未指定時は controlled 前提のフォールバック値を使う (親が WorkspacePicker で解決する想定)。
 */

"use client";

import * as React from "react";
import { Loading } from "../../../../components/Loading";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  FileText,
  Folder,
  Globe,
  LayoutDashboard,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import {
  EmployeeIcon,
  type EmployeeId,
} from "../../../../components/EmployeeIcon";
import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";
import { KbButton, KbDenied } from "./ui";
import { TreeNode } from "./TreeNode";
import { NodeDetail } from "./NodeDetail";
import {
  CreateKnowledgeDialog,
  type KnowledgeDraft,
} from "./CreateKnowledgeDialog";
import { NoteMarkdown } from "./NoteMarkdown";
import { SCOPES, type KnowledgeNode, type KnowledgeScope } from "./types";
import { fmtDateTime } from "../../../../lib/format";

/** scope ごとのツリーグループ・アイコン (モックの globe / users / folder 見出し)。 */
const SCOPE_ICON: Record<KnowledgeScope, typeof Globe> = {
  common: Globe,
  employee_specific: Users,
  project: Folder,
};

/** workspaceId 未指定時のフォールバック (親が WorkspacePicker で解決するまでの controlled 既定)。 */
const FALLBACK_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

export interface KnowledgeExplorerProps {
  readonly client?: ApiClient;
  /** 現在の workspace UUID。未指定なら FALLBACK を使う (親で WorkspacePicker から渡す想定)。 */
  readonly workspaceId?: string;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function unwrap(res: unknown): KnowledgeNode[] {
  return (res as { data?: KnowledgeNode[] }).data ?? [];
}

interface SearchHit {
  readonly node: KnowledgeNode;
  readonly score: number;
}

function unwrapHits(res: unknown): SearchHit[] {
  const data = (res as {
    data?: { hits?: { knowledge?: KnowledgeNode; score?: number }[] };
  }).data;
  return (data?.hits ?? [])
    .filter((h): h is { knowledge: KnowledgeNode; score: number } =>
      Boolean(h.knowledge),
    )
    .map((h) => ({ node: h.knowledge, score: h.score ?? 0 }));
}

interface EmployeeLite {
  readonly id: string;
  readonly name?: string;
  readonly display_name?: string;
  readonly icon?: string | null;
}

interface ProjectLite {
  readonly id: string;
  readonly name: string;
}

export function KnowledgeExplorer({
  client: injected,
  workspaceId,
}: KnowledgeExplorerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const queryClient = useQueryClient();
  const accountId = workspaceId ?? FALLBACK_WORKSPACE_ID;

  const [scope, setScope] = useState<KnowledgeScope>("common");
  const [selected, setSelected] = useState<KnowledgeNode | null>(null);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [childrenByParent, setChildrenByParent] = useState<
    Readonly<Record<string, readonly KnowledgeNode[]>>
  >({});
  const [loadingIds, setLoadingIds] = useState<ReadonlySet<string>>(new Set());
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [view, setView] = useState<"note" | "list">("note");
  // モバイル (1 カラム積み) では本文が画面外に出るため、選択時にスクロールする
  const noteRef = React.useRef<HTMLElement | null>(null);
  const selectAndReveal = (node: KnowledgeNode): void => {
    setSelected(node);
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      requestAnimationFrame(() => {
        noteRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  };
  const [searchInput, setSearchInput] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);

  const rootKey = ["knowledge", "tree", accountId, scope] as const;

  // ルートノード: scope ごとに tree_only=true で取得 (platform / visible_in_tree=false は除外)。
  const rootQuery = useQuery({
    queryKey: rootKey,
    queryFn: async () => {
      const res = await client.get("/knowledge", {
        params: {
          query: {
            account_type: "workspace",
            account_id: accountId,
            scope,
            tree_only: true,
          },
        },
      });
      return unwrap(res);
    },
    retry: false,
  });

  // 名前解決 (ツリーの社員グルーピング / プロジェクト見出し / オーナー表示)
  const employeesQuery = useQuery({
    queryKey: ["knowledge-employees"],
    queryFn: async () => {
      const res = await client.get("/ai-employees");
      return (res as { data?: EmployeeLite[] }).data ?? [];
    },
    retry: false,
  });
  const projectsQuery = useQuery({
    queryKey: ["knowledge-projects"],
    queryFn: async () => {
      const res = await client.get("/projects", {
        params: { query: { limit: 50 } },
      });
      return (res as { data?: ProjectLite[] }).data ?? [];
    },
    retry: false,
  });

  // RAG 検索 (POST /knowledge/search)。Voyage 未設定環境では text 検索に degrade する実 API。
  const searchMut = useMutation({
    mutationFn: async (q: string) => {
      const res = await client.post("/knowledge/search", {
        body: { query: q, account_id: accountId, limit: 20 },
      });
      return unwrapHits(res);
    },
    onSuccess: (hits) => setSearchHits(hits),
  });

  const runSearch = (): void => {
    const q = searchInput.trim();
    if (q) searchMut.mutate(q);
  };
  const clearSearch = (): void => {
    setSearchInput("");
    setSearchHits(null);
  };

  // 関連ナレッジ (RAG): タイトル → タグの順で類似検索し、自分自身を除く上位 3 件。
  // (embedding 未設定環境は text 部分一致に degrade するため、タイトルだけだと
  //  自己ヒットのみになりがち — タグでの追撃検索で関連を実データから拾う)
  const relatedQuery = useQuery({
    queryKey: ["knowledge", "related", selected?.id ?? "none"],
    enabled: Boolean(selected),
    queryFn: async () => {
      const node = selected!;
      const queries = [node.title, ...node.tags.slice(0, 3)];
      const found = new Map<string, SearchHit>();
      for (const q of queries) {
        const res = await client.post("/knowledge/search", {
          body: { query: q, account_id: accountId, limit: 6 },
        });
        for (const h of unwrapHits(res)) {
          if (h.node.id !== node.id && !found.has(h.node.id))
            found.set(h.node.id, h);
        }
        if (found.size >= 3) break;
      }
      return [...found.values()].slice(0, 3);
    },
    retry: false,
  });

  // ノード展開時: 子を parent_id で遅延取得し、childrenByParent にキャッシュする。
  const fetchChildren = async (node: KnowledgeNode): Promise<void> => {
    if (childrenByParent[node.id] !== undefined) return;
    setLoadingIds((prev) => new Set(prev).add(node.id));
    try {
      const res = await client.get("/knowledge", {
        params: {
          query: {
            account_type: "workspace",
            account_id: accountId,
            scope,
            tree_only: true,
            parent_id: node.id,
          },
        },
      });
      // 循環ガード: parent_id が一致する行だけを子として採用する
      // (自己参照や無関係行が混ざると TreeNode が無限再帰し得る)。
      const children = unwrap(res).filter(
        (c) => c.parent_id === node.id && c.id !== node.id,
      );
      setChildrenByParent((prev) => ({ ...prev, [node.id]: children }));
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(node.id);
        return next;
      });
    }
  };

  const toggleNode = (node: KnowledgeNode): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
        void fetchChildren(node);
      }
      return next;
    });
  };

  const switchScope = (next: KnowledgeScope): void => {
    setScope(next);
    setSelected(null);
    setExpandedIds(new Set());
    setChildrenByParent({});
  };

  const createMut = useMutation({
    mutationFn: (draft: KnowledgeDraft) =>
      client.post("/knowledge", {
        body: {
          account_type: "workspace",
          account_id: accountId,
          scope,
          category: draft.category,
          title: draft.title,
          content_md: draft.content_md,
          visible_in_tree: true,
          source_type: "manual",
          confidence_score: 0.5,
          is_anonymized: false,
        },
      }),
    onSuccess: () => {
      setDialogOpen(false);
      void queryClient.invalidateQueries({ queryKey: rootKey });
    },
  });

  // 共通ナレッジへ昇格 (user/その他 scope → workspace common)。成功でツリー再取得。
  const promoteMut = useMutation({
    mutationFn: (id: string) =>
      client.post("/knowledge/{knowledge_id}/promote", {
        params: { path: { knowledge_id: id } },
        body: { target_workspace_id: accountId },
      }),
    onSuccess: () => {
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: rootKey });
    },
  });

  // 論理削除 → DELETE /knowledge/{id}。DELETE API は存在したが UI に未配線で、
  // 誤保存・重複ノートを画面から消せなかった (削除ボタンが無かった)。成功でツリー再取得。
  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      client.delete("/knowledge/{knowledge_id}", {
        params: { path: { knowledge_id: id } },
      }),
    onSuccess: () => {
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: rootKey });
    },
  });

  // 本文編集 (title / content_md) → PATCH /knowledge/{id}。以前は「編集」ボタンが非機能だった。
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");

  const editMut = useMutation({
    mutationFn: (v: { id: string; title: string; content_md: string }) =>
      client.patch("/knowledge/{knowledge_id}", {
        params: { path: { knowledge_id: v.id } },
        body: { title: v.title, content_md: v.content_md },
      }),
    onSuccess: (_res, v) => {
      setSelected((prev) =>
        prev ? { ...prev, title: v.title, content_md: v.content_md } : prev,
      );
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: rootKey });
    },
  });

  const startEdit = (): void => {
    if (!selected) return;
    setEditTitle(selected.title);
    setEditContent(selected.content_md);
    setEditing(true);
  };

  // 複製: 選択ノートを実 POST /knowledge でコピー (Rule 10: 死にボタン化を許さない)。
  const duplicateMut = useMutation({
    mutationFn: (node: KnowledgeNode) =>
      client.post("/knowledge", {
        body: {
          account_type: "workspace",
          account_id: accountId,
          scope: node.scope,
          category: node.category,
          title: `${node.title}（複製）`,
          content_md: node.content_md,
          tags: [...node.tags],
          ...(node.owner_employee_id
            ? { owner_employee_id: node.owner_employee_id }
            : {}),
          visible_in_tree: true,
          source_type: "manual",
          confidence_score: node.confidence_score ?? 0.5,
          is_anonymized: false,
        },
      }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: rootKey }),
  });

  if (isForbidden(rootQuery.error)) return <KbDenied />;

  const all = rootQuery.data ?? [];
  // GET /knowledge (parent_id なし) は子ノードも返すため、ツリーのルートは
  // parent_id 無しの行だけに絞る (子がルートにも重複表示される実バグの是正)。
  const roots = all.filter((n) => !n.parent_id);
  const currentScope = SCOPES.find((s) => s.id === scope);
  const ScopeIcon = SCOPE_ICON[scope];

  const employees = employeesQuery.data ?? [];
  const employeeById = new Map(employees.map((e) => [e.id, e]));
  const projects = projectsQuery.data ?? [];
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
  const ownerName = (id: string | null | undefined): string | undefined =>
    id ? (employeeById.get(id)?.display_name ?? id) : undefined;

  // モック準拠のグルーピング: AI社員別 scope は社員ごと、プロジェクト別 scope は案件ごと。
  const treeGroups: { key: string; header: React.ReactNode | null; nodes: KnowledgeNode[] }[] =
    scope === "employee_specific"
      ? [...new Set(roots.map((n) => n.owner_employee_id ?? ""))].map((eid) => {
          const emp = employeeById.get(eid);
          return {
            key: eid || "none",
            header: emp ? (
              <span className="flex items-center gap-2 px-2.5 py-1 text-[12px] font-semibold text-on-surface">
                <EmployeeIcon
                  employeeId={(emp.name ?? "tony") as EmployeeId}
                  size="sm"
                  {...(emp.icon ? { iconName: emp.icon } : {})}
                />
                {emp.display_name}
              </span>
            ) : null,
            nodes: roots.filter((n) => (n.owner_employee_id ?? "") === eid),
          };
        })
      : scope === "project"
        ? [...new Set(roots.map((n) => n.source_project_id ?? ""))].map((pid) => ({
            key: pid || "none",
            header: pid ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 text-[12px] font-semibold text-on-surface">
                <Folder className="h-3.5 w-3.5 text-on-surface-variant" aria-hidden="true" />
                {projectNameById.get(pid) ?? pid}
              </span>
            ) : null,
            nodes: roots.filter((n) => (n.source_project_id ?? "") === pid),
          }))
        : [{ key: "all", header: null, nodes: roots }];

  return (
    <section
      aria-label="ナレッジエクスプローラ"
      className={cn(
        // モバイル(〜lg)は縦積み 1 カラム (固定 280px+320px の 3 ペインは 320px で
        // 横オーバーフローする実バグが E2E で出たため lg 以上でのみ 3 ペイン化)
        "grid grid-cols-1 overflow-hidden rounded-lg border border-border bg-surface",
        "lg:h-[calc(100dvh-12rem)] lg:transition-[grid-template-columns] lg:duration-200 lg:ease-out-expo",
        leftCollapsed && rightCollapsed
          ? "lg:grid-cols-[0_1fr_0]"
          : leftCollapsed
            ? "lg:grid-cols-[0_1fr_320px]"
            : rightCollapsed
              ? "lg:grid-cols-[280px_1fr_0]"
              : "lg:grid-cols-[280px_1fr_320px]",
      )}
    >
      {/* 左: ツリーペイン */}
      <aside
        className={cn(
          "flex min-w-0 flex-col overflow-y-auto bg-white p-3 lg:border-r lg:border-border",
          // display:none にすると grid の列割当がずれて main が 0 幅列に落ちるため
          // (モック panels.js と同じく) lg では DOM に残して 0 幅 + overflow hidden で畳む。
          leftCollapsed && "hidden lg:flex lg:overflow-hidden lg:border-0 lg:p-0",
        )}
      >
        {/* RAG 検索 (実 POST /knowledge/search — Enter で実行) */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
          className="mb-3 flex items-center gap-2 rounded-md bg-surface-variant px-2.5 py-2"
        >
          <Search
            className="h-3.5 w-3.5 shrink-0 text-on-surface-variant"
            aria-hidden="true"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="ナレッジを検索（RAG）"
            placeholder="ナレッジを検索（RAG）…"
            className="w-full min-w-0 border-none bg-transparent text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant"
          />
          {searchHits !== null ? (
            <button
              type="button"
              aria-label="検索をクリア"
              onClick={clearSearch}
              className="shrink-0 rounded p-0.5 text-on-surface-variant hover:text-on-surface"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </form>

        {/* 新規追加 */}
        <KbButton
          variant="primary"
          size="sm"
          className="mb-3 w-full"
          onClick={() => setDialogOpen(true)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          新規追加
        </KbButton>

        {/* scope 切替 (共通 / AI社員別 / プロジェクト別) */}
        <div
          role="tablist"
          aria-label="スコープ"
          className="mb-3 flex gap-1 rounded-md bg-surface-variant p-1"
        >
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={scope === s.id}
              onClick={() => switchScope(s.id)}
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors",
                scope === s.id
                  ? "bg-white text-on-surface shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* 現 scope のグループ見出し */}
        <div className="mb-1.5 flex items-center gap-1.5 px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.08em] text-on-surface-variant">
          <ScopeIcon className="h-3 w-3" aria-hidden="true" />
          {currentScope?.label}ナレッジ
          <span className="ml-auto tabular-nums">{roots.length}</span>
        </div>

        {searchHits !== null ? (
          /* 検索結果モード: ツリーの代わりにヒット一覧 (スコア付き) */
          <div aria-label="検索結果" className="flex flex-col gap-px">
            <p className="px-2.5 py-1 text-[11px] text-on-surface-variant">
              検索結果 {searchHits.length} 件
            </p>
            {searchMut.isPending ? (
              <Loading className="py-sm" />
            ) : searchHits.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-on-surface-variant">
                一致するナレッジがありません
              </p>
            ) : (
              searchHits.map((h) => (
                <button
                  key={h.node.id}
                  type="button"
                  onClick={() => selectAndReveal(h.node)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-[5px] text-left text-[13px]",
                    selected?.id === h.node.id
                      ? "bg-primary-container font-semibold text-primary-container-fg"
                      : "text-on-surface hover:bg-surface-variant",
                  )}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" aria-hidden="true" />
                  <span className="truncate">{h.node.title}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-on-surface-variant">
                    {h.score.toFixed(2)}
                  </span>
                </button>
              ))
            )}
          </div>
        ) : rootQuery.isLoading ? (
          <Loading className="py-md" />
        ) : roots.length === 0 ? (
          <p className="px-2.5 py-2 text-[13px] text-on-surface-variant">
            ナレッジがありません
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {treeGroups
              .filter((g) => g.nodes.length > 0)
              .map((g) => (
                <div key={g.key}>
                  {g.header}
                  <ul
                    role="tree"
                    aria-label={`${scope} ナレッジツリー`}
                    className="flex flex-col gap-px"
                  >
                    {g.nodes.map((node) => (
                      <TreeNode
                        key={node.id}
                        node={node}
                        depth={0}
                        selectedId={selected?.id ?? null}
                        expandedIds={expandedIds}
                        childrenByParent={childrenByParent}
                        loadingIds={loadingIds}
                        onToggle={toggleNode}
                        onSelect={selectAndReveal}
                      />
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        )}

        <p className="mt-auto flex items-center gap-2 border-t border-border pt-2.5 text-[11px] text-on-surface-variant">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          運営デフォルト・ナレッジは参照のみ（ツリー非表示）
        </p>
      </aside>

      {/* 中央: ノート本文 + ツールバー */}
      <div className="flex min-w-0 flex-col overflow-hidden bg-surface">
        <div className="flex items-center gap-2 overflow-x-auto border-b border-border bg-surface/95 px-4 py-2.5 backdrop-blur">
          <button
            type="button"
            aria-label="ツリーパネルを開閉"
            aria-pressed={leftCollapsed}
            onClick={() => setLeftCollapsed((v) => !v)}
            title="ツリーを開閉"
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
              leftCollapsed
                ? "bg-primary-container text-primary-container-fg"
                : "text-on-surface hover:bg-surface-variant",
            )}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>

          {/* view-toggle: ノート / リスト (両方実ビュー)。グラフはグラフ描画未実装のため
              未描画 (GAP-010)。Obsidian 連携も API 不在のため未描画 (GAP-011)。 */}
          <div className="flex shrink-0 gap-1 rounded-md bg-surface-variant p-1">
            <button
              type="button"
              aria-pressed={view === "note"}
              onClick={() => setView("note")}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-semibold",
                view === "note"
                  ? "bg-white text-on-surface shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface",
              )}
            >
              <FileText className="h-3 w-3" aria-hidden="true" />
              ノート
            </button>
            <button
              type="button"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-semibold",
                view === "list"
                  ? "bg-white text-on-surface shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface",
              )}
            >
              <LayoutDashboard className="h-3 w-3" aria-hidden="true" />
              リスト
            </button>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <KbButton
              variant="ghost"
              size="sm"
              onClick={() => selected && duplicateMut.mutate(selected)}
              disabled={!selected || duplicateMut.isPending}
              title={selected ? "選択中のノートを複製" : "ノートを選択してください"}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              {duplicateMut.isPending ? "複製中…" : "複製"}
            </KbButton>
            <KbButton
              variant="outlined"
              size="sm"
              onClick={startEdit}
              disabled={!selected || editing}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              編集
            </KbButton>
            <button
              type="button"
              aria-label="詳細パネルを開閉"
              aria-pressed={rightCollapsed}
              onClick={() => setRightCollapsed((v) => !v)}
              title="詳細パネルを開閉"
              className={cn(
                "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
                rightCollapsed
                  ? "bg-primary-container text-primary-container-fg"
                  : "text-on-surface hover:bg-surface-variant",
              )}
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        <article ref={noteRef} className="flex-1 scroll-mt-[64px] overflow-y-auto px-6 py-8 lg:px-12">
          {view === "list" ? (
            /* リストビュー: 現 scope の全ノード (フォルダ含む) をフラット表で。行クリックで選択。 */
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full min-w-[640px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-border bg-surface-variant text-[11.5px] font-bold text-on-surface-variant">
                    <th scope="col" className="px-4 py-2.5">タイトル</th>
                    <th scope="col" className="px-4 py-2.5">カテゴリ</th>
                    <th scope="col" className="px-4 py-2.5">タグ</th>
                    <th scope="col" className="px-4 py-2.5">信頼度</th>
                    <th scope="col" className="px-4 py-2.5">参照</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((n) => (
                    <tr
                      key={n.id}
                      className={cn(
                        "border-b border-border last:border-b-0",
                        selected?.id === n.id
                          ? "bg-primary-container/50"
                          : "hover:bg-surface-variant",
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => {
                            selectAndReveal(n);
                            setView("note");
                          }}
                          className="text-[13px] font-semibold text-on-surface hover:text-primary"
                        >
                          {n.title}
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-[12px] text-on-surface-variant">{n.category}</td>
                      <td className="px-4 py-2.5 text-[11.5px] text-on-surface-variant">
                        {n.tags.join(", ")}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] tabular-nums text-on-surface">
                        {(n.confidence_score ?? 0).toFixed(2)}
                      </td>
                      <td className="px-4 py-2.5 text-[12px] tabular-nums text-on-surface">
                        {n.usage_count ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : selected && editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (editTitle.trim()) {
                  editMut.mutate({
                    id: selected.id,
                    title: editTitle.trim(),
                    content_md: editContent,
                  });
                }
              }}
              className="flex flex-col gap-4"
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-on-surface-variant">
                  タイトル
                </span>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="h-11 rounded-md border border-border bg-surface px-3 text-[18px] font-bold text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-on-surface-variant">
                  本文
                </span>
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  rows={16}
                  className="rounded-md border border-border bg-surface px-3 py-2 text-[14px] leading-[1.85] text-on-surface focus:border-primary focus:outline-none"
                />
              </label>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="inline-flex h-10 items-center rounded-md px-4 text-sm font-semibold text-on-surface hover:bg-surface-variant"
                >
                  キャンセル
                </button>
                <button
                  type="submit"
                  disabled={!editTitle.trim() || editMut.isPending}
                  className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-semibold text-on-primary hover:bg-[#1E54D8] disabled:opacity-50"
                >
                  {editMut.isPending ? "保存中…" : "保存"}
                </button>
              </div>
            </form>
          ) : selected ? (
            <>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.12em] text-on-surface-variant">
                {selected.category}
              </p>
              <h2 className="mb-3 text-[28px] font-bold leading-tight tracking-[-0.02em] text-on-surface">
                {selected.title}
              </h2>
              <div className="mb-6 flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-border pb-4 text-[12.5px] text-on-surface-variant">
                {selected.updated_at ? (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" aria-hidden="true" />
                    {fmtDateTime(selected.updated_at)} 更新
                  </span>
                ) : null}
                <span>
                  参照{" "}
                  <strong className="tabular-nums text-on-surface">
                    {selected.usage_count ?? 0}
                  </strong>{" "}
                  回
                </span>
                {selected.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {selected.tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center rounded-full bg-primary-container px-2.5 py-0.5 text-[11px] font-semibold text-primary-container-fg"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <NoteMarkdown content={selected.content_md} />
            </>
          ) : (
            <p className="py-12 text-center text-body-md text-on-surface-variant">
              ツリーからナレッジを選択してください
            </p>
          )}
        </article>
      </div>

      {/* 右: メタ詳細ペイン */}
      <aside
        className={cn(
          "min-w-0 overflow-y-auto bg-white p-[18px] lg:border-l lg:border-border",
          rightCollapsed && "hidden lg:block lg:overflow-hidden lg:border-0 lg:p-0",
        )}
      >
        <NodeDetail
          node={selected}
          ownerName={ownerName(selected?.owner_employee_id)}
          related={relatedQuery.data ?? []}
          onSelectRelated={(node) => setSelected(node)}
          onPromote={(id) => promoteMut.mutate(id)}
          promoting={promoteMut.isPending}
          onDelete={(id) => deleteMut.mutate(id)}
          deleting={deleteMut.isPending}
        />
      </aside>

      <CreateKnowledgeDialog
        open={dialogOpen}
        scope={scope}
        submitting={createMut.isPending}
        onClose={() => setDialogOpen(false)}
        onSubmit={(draft) => createMut.mutate(draft)}
      />
    </section>
  );
}
