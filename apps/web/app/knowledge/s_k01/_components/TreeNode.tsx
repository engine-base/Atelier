/**
 * TreeNode — S-K01 構造ツリーの 1 ノード (T-UC-43)
 *
 * parent_id 構造ツリー。展開時に子ノードを GET /knowledge?parent_id=<id> で遅延取得する。
 * children を持つ可能性のあるノードは aria-expanded 付き button (treeitem) で開閉でき、
 * 開いたとき onExpand(node.id) 経由で親が子取得 query を起動する。
 *
 * 葉ノード/選択は onSelect(node) で親に伝える。RLS 越境はサーバ側で担保され、
 * この UI は member token で API を呼ぶだけ (越境=0 はサーバ責務)。
 */

"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, FileText } from "lucide-react";

import { cn } from "../../../../lib/cn";
import type { KnowledgeNode } from "./types";

export interface TreeNodeProps {
  readonly node: KnowledgeNode;
  readonly depth: number;
  readonly selectedId: string | null;
  readonly expandedIds: ReadonlySet<string>;
  /** node.id -> その子ノード配列 (未取得なら undefined)。 */
  readonly childrenByParent: Readonly<Record<string, readonly KnowledgeNode[]>>;
  /** node.id -> 子取得中フラグ。 */
  readonly loadingIds: ReadonlySet<string>;
  readonly onToggle: (node: KnowledgeNode) => void;
  readonly onSelect: (node: KnowledgeNode) => void;
}

export function TreeNode({
  node,
  depth,
  selectedId,
  expandedIds,
  childrenByParent,
  loadingIds,
  onToggle,
  onSelect,
}: TreeNodeProps) {
  const expanded = expandedIds.has(node.id);
  const loaded = childrenByParent[node.id];
  const loading = loadingIds.has(node.id);
  const children = loaded ?? [];
  const selected = selectedId === node.id;

  return (
    <li role="none">
      <button
        type="button"
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expanded}
        aria-label={node.title}
        onClick={() => {
          onSelect(node);
          onToggle(node);
        }}
        style={{ paddingLeft: `${10 + depth * 12}px` }}
        className={cn(
          "flex w-full items-center gap-2 rounded-md py-[5px] pr-2.5 text-left text-[13px]",
          selected
            ? "bg-primary-container font-semibold text-primary-container-fg"
            : "text-on-surface hover:bg-surface-variant",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex h-3.5 w-3.5 shrink-0 items-center justify-center",
            selected ? "text-primary-container-fg" : "text-on-surface-variant",
          )}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
        <FileText
          aria-hidden="true"
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            selected ? "text-primary-container-fg" : "text-on-surface-variant",
          )}
        />
        <span className="truncate">{node.title}</span>
        <span
          className={cn(
            "ml-auto shrink-0 text-[10.5px]",
            selected ? "text-primary-container-fg" : "text-on-surface-variant",
          )}
        >
          {node.category}
        </span>
      </button>

      {expanded ? (
        <ul role="group" className="flex flex-col gap-px">
          {loading ? (
            <li
              role="none"
              className="py-[5px] pl-6 text-[11px] text-on-surface-variant"
            >
              読み込み中…
            </li>
          ) : children.length === 0 ? (
            <li
              role="none"
              className="py-[5px] pl-6 text-[11px] text-on-surface-variant"
            >
              子ナレッジはありません
            </li>
          ) : (
            children.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedId={selectedId}
                expandedIds={expandedIds}
                childrenByParent={childrenByParent}
                loadingIds={loadingIds}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}
