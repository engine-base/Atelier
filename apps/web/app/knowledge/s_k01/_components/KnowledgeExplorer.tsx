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
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

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

  if (isForbidden(rootQuery.error)) return <KbDenied />;

  const roots = rootQuery.data ?? [];

  return (
    <section
      aria-label="ナレッジエクスプローラ"
      className={cn(
        "grid h-[calc(100dvh-12rem)] gap-md transition-[grid-template-columns] duration-200",
        leftCollapsed && rightCollapsed
          ? "grid-cols-[0_1fr_0]"
          : leftCollapsed
            ? "grid-cols-[0_1fr_20rem]"
            : rightCollapsed
              ? "grid-cols-[18rem_1fr_0]"
              : "grid-cols-[18rem_1fr_20rem]",
      )}
    >
      {/* 左: ツリー */}
      <aside
        className={cn(
          "flex min-w-0 flex-col gap-md overflow-y-auto rounded-lg border border-surface-variant p-sm",
          leftCollapsed && "hidden",
        )}
      >
        <div
          role="tablist"
          aria-label="スコープ"
          className="flex border-b border-surface-variant"
        >
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={scope === s.id}
              onClick={() => switchScope(s.id)}
              className={cn(
                "flex-1 py-xs text-label-sm",
                scope === s.id
                  ? "border-b-2 border-primary font-semibold text-primary"
                  : "text-on-surface-variant",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>

        <KbButton
          variant="primary"
          size="sm"
          onClick={() => setDialogOpen(true)}
        >
          新規追加
        </KbButton>

        {rootQuery.isLoading ? (
          <p className="text-body-sm text-on-surface-variant">読み込み中…</p>
        ) : roots.length === 0 ? (
          <p className="text-body-sm text-on-surface-variant">
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

        <p className="mt-auto flex items-center gap-xs border-t border-surface-variant pt-sm text-label-sm text-on-surface-variant">
          運営デフォルト・ナレッジは参照のみ（ツリー非表示）
        </p>
      </aside>

      {/* 中央: ノート本文 + パネルトグル */}
      <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-surface-variant">
        <div className="flex items-center gap-sm border-b border-surface-variant p-sm">
          <button
            type="button"
            aria-label="ツリーパネルを開閉"
            aria-pressed={leftCollapsed}
            onClick={() => setLeftCollapsed((v) => !v)}
            className="rounded-md px-sm py-xs text-label-md text-on-surface hover:bg-surface-variant"
          >
            ◀
          </button>
          <span className="text-label-md font-semibold text-on-surface">
            {selected?.title ?? "ナレッジ"}
          </span>
          <button
            type="button"
            aria-label="詳細パネルを開閉"
            aria-pressed={rightCollapsed}
            onClick={() => setRightCollapsed((v) => !v)}
            className="ml-auto rounded-md px-sm py-xs text-label-md text-on-surface hover:bg-surface-variant"
          >
            ▶
          </button>
        </div>
        <article className="flex-1 overflow-y-auto p-lg">
          {selected ? (
            <>
              <p className="mb-xs text-label-sm uppercase tracking-wide text-on-surface-variant">
                {selected.category}
              </p>
              <h2 className="mb-md text-headline-md font-bold text-on-surface">
                {selected.title}
              </h2>
              <p className="whitespace-pre-wrap text-body-md leading-relaxed text-on-surface">
                {selected.content_md}
              </p>
            </>
          ) : (
            <p className="text-body-md text-on-surface-variant">
              左のツリーからナレッジを選択してください
            </p>
          )}
        </article>
      </div>

      {/* 右: メタ詳細 */}
      <aside
        className={cn(
          "min-w-0 overflow-y-auto rounded-lg border border-surface-variant p-md",
          rightCollapsed && "hidden",
        )}
      >
        <NodeDetail node={selected} />
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
