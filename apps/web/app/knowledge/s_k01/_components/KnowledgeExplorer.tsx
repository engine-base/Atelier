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
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  Globe,
  LayoutDashboard,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { cn } from "../../../../lib/cn";
import { KbButton, KbDenied } from "./ui";
import { TreeNode } from "./TreeNode";
import { NodeDetail } from "./NodeDetail";
import {
  CreateKnowledgeDialog,
  type KnowledgeDraft,
} from "./CreateKnowledgeDialog";
import { SCOPES, type KnowledgeNode, type KnowledgeScope } from "./types";

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
      setChildrenByParent((prev) => ({ ...prev, [node.id]: unwrap(res) }));
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

  if (isForbidden(rootQuery.error)) return <KbDenied />;

  const roots = rootQuery.data ?? [];
  const currentScope = SCOPES.find((s) => s.id === scope);
  const ScopeIcon = SCOPE_ICON[scope];

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
          leftCollapsed && "hidden",
        )}
      >
        {/* RAG 検索 (表示のみ) */}
        <div className="mb-3 flex items-center gap-2 rounded-md bg-surface-variant px-2.5 py-2">
          <Search
            className="h-3.5 w-3.5 shrink-0 text-on-surface-variant"
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="ナレッジを検索（RAG）"
            placeholder="ナレッジを検索（RAG）…"
            className="w-full min-w-0 border-none bg-transparent text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </div>

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

        {rootQuery.isLoading ? (
          <Loading className="py-md" />
        ) : roots.length === 0 ? (
          <p className="px-2.5 py-2 text-[13px] text-on-surface-variant">
            ナレッジがありません
          </p>
        ) : (
          <ul
            role="tree"
            aria-label={`${scope} ナレッジツリー`}
            className="flex flex-col gap-px"
          >
            {roots.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                selectedId={selected?.id ?? null}
                expandedIds={expandedIds}
                childrenByParent={childrenByParent}
                loadingIds={loadingIds}
                onToggle={toggleNode}
                onSelect={setSelected}
              />
            ))}
          </ul>
        )}

        <p className="mt-auto flex items-center gap-2 border-t border-border pt-2.5 text-[11px] text-on-surface-variant">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          運営デフォルト・ナレッジは参照のみ（ツリー非表示）
        </p>
      </aside>

      {/* 中央: ノート本文 + ツールバー */}
      <div className="flex min-w-0 flex-col overflow-hidden bg-surface">
        <div className="flex items-center gap-2 border-b border-border bg-surface/95 px-4 py-2.5 backdrop-blur">
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

          {/* view-toggle: ノートのみ実装。リスト/グラフは未実装のため非活性(機能を偽らない)。 */}
          <div className="flex gap-1 rounded-md bg-surface-variant p-1">
            <button
              type="button"
              aria-pressed="true"
              className="inline-flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-[12px] font-semibold text-on-surface shadow-sm"
            >
              <FileText className="h-3 w-3" aria-hidden="true" />
              ノート
            </button>
            <button
              type="button"
              disabled
              title="リスト表示は準備中です"
              className="inline-flex cursor-not-allowed items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface-variant opacity-50"
            >
              <LayoutDashboard className="h-3 w-3" aria-hidden="true" />
              リスト
            </button>
            <button
              type="button"
              disabled
              title="グラフ表示は準備中です"
              className="inline-flex cursor-not-allowed items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface-variant opacity-50"
            >
              <GitBranch className="h-3 w-3" aria-hidden="true" />
              グラフ
            </button>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            {/* 複製 / Obsidian 連携は対応API無し。機能を偽らないよう非活性。 */}
            <KbButton variant="ghost" size="sm" disabled title="準備中です">
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              複製
            </KbButton>
            <KbButton
              variant="ghost"
              size="sm"
              disabled
              title="Obsidian 連携は準備中です"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              Obsidian で開く
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

        <article className="flex-1 overflow-y-auto px-6 py-8 lg:px-12">
          {selected && editing ? (
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
                    {selected.updated_at} 更新
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
              <p className="whitespace-pre-wrap text-[14px] leading-[1.85] text-on-surface">
                {selected.content_md}
              </p>
            </>
          ) : (
            <p className="py-12 text-center text-body-md text-on-surface-variant">
              左のツリーからナレッジを選択してください
            </p>
          )}
        </article>
      </div>

      {/* 右: メタ詳細ペイン */}
      <aside
        className={cn(
          "min-w-0 overflow-y-auto bg-white p-[18px] lg:border-l lg:border-border",
          rightCollapsed && "hidden",
        )}
      >
        <NodeDetail
          node={selected}
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
