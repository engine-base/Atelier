/**
 * KnowledgeGraph — S-K01 グラフビュー (GAP-010)
 *
 * GET /knowledge/graph の実データ (ノード + parent 階層/タグ共起エッジ) を
 * SVG で描画する。レイアウトは決定的な円形配置 (カテゴリ→タイトル順) —
 * 乱数・外部グラフライブラリなし (DependencyGraph と同方針)。
 * ノードクリックで選択 → ノートビューへ遷移する。
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";
import type { KnowledgeScope } from "./types";

export interface GraphNode {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly scope: KnowledgeScope;
  readonly tags: readonly string[];
  readonly usage_count: number;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly kind: "parent" | "tag";
  readonly tag?: string | null;
}

export interface KnowledgeGraphProps {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly truncated?: boolean;
  readonly selectedId?: string | null;
  readonly onSelectNode?: (id: string) => void;
}

const W = 860;
const H = 620;
const CX = W / 2;
const CY = H / 2;

/** scope ごとのノード配色 (ツリーの scope タブと同系統)。 */
const SCOPE_FILL: Record<KnowledgeScope, string> = {
  common: "#2563EB",
  employee_specific: "#7C3AED",
  project: "#0D9488",
};

interface Placed extends GraphNode {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

/** 決定的円形レイアウト: カテゴリ → タイトル順で円周に等間隔配置。 */
export function layoutCircular(nodes: readonly GraphNode[]): Placed[] {
  const ordered = [...nodes].sort(
    (a, b) =>
      a.category.localeCompare(b.category) || a.title.localeCompare(b.title),
  );
  const n = ordered.length;
  const radius = n <= 1 ? 0 : Math.min(CY - 70, 120 + n * 9);
  return ordered.map((node, i) => {
    const angle = (2 * Math.PI * i) / Math.max(n, 1) - Math.PI / 2;
    return {
      ...node,
      x: CX + radius * Math.cos(angle),
      y: CY + radius * Math.sin(angle),
      // 参照回数で半径を可変 (7〜16px) — 実データの重み付け
      r: 7 + Math.min(9, Math.sqrt(node.usage_count)),
    };
  });
}

export function KnowledgeGraph({
  nodes,
  edges,
  truncated = false,
  selectedId,
  onSelectNode,
}: KnowledgeGraphProps) {
  if (nodes.length === 0) {
    return (
      <p className="py-12 text-center text-body-md text-on-surface-variant">
        グラフに表示できるナレッジがありません
      </p>
    );
  }
  const placed = layoutCircular(nodes);
  const byId = new Map(placed.map((p) => [p.id, p]));
  const drawable = edges.filter((e) => byId.has(e.source) && byId.has(e.target));

  return (
    <figure aria-label="ナレッジグラフ" className="flex flex-col gap-3">
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-on-surface-variant">
        <span>
          ノード {nodes.length} 件 · リンク {drawable.length} 本
          (実線 = 階層 / 破線 = タグ共起)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_FILL.common }} />
          共通
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_FILL.employee_specific }} />
          AI社員別
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: SCOPE_FILL.project }} />
          プロジェクト別
        </span>
        {truncated ? (
          <span className="font-semibold text-secondary">
            参照回数上位 120 件のみ表示中
          </span>
        ) : null}
      </figcaption>
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full min-w-[640px]"
          role="img"
          aria-label={`ナレッジ ${nodes.length} 件と ${drawable.length} 本のリンク`}
        >
          {/* エッジ */}
          {drawable.map((e, i) => {
            const s = byId.get(e.source)!;
            const t = byId.get(e.target)!;
            return (
              <line
                key={`${e.source}-${e.target}-${i}`}
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={e.kind === "parent" ? "#2563EB" : "#94A3B8"}
                strokeWidth={e.kind === "parent" ? 1.8 : 1.1}
                strokeDasharray={e.kind === "tag" ? "4 4" : undefined}
                opacity={0.55}
              >
                <title>
                  {e.kind === "parent" ? "階層" : `タグ共起: ${e.tag ?? ""}`}
                </title>
              </line>
            );
          })}
          {/* ノード */}
          {placed.map((p) => {
            const selected = p.id === selectedId;
            const label = p.title.length > 14 ? `${p.title.slice(0, 13)}…` : p.title;
            return (
              <g
                key={p.id}
                role="button"
                tabIndex={0}
                aria-label={`ナレッジ: ${p.title}`}
                onClick={() => onSelectNode?.(p.id)}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") onSelectNode?.(p.id);
                }}
                className={cn("cursor-pointer focus:outline-none", onSelectNode && "hover:opacity-80")}
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={p.r + (selected ? 3 : 0)}
                  fill={SCOPE_FILL[p.scope]}
                  stroke={selected ? "#0F172A" : "#FFFFFF"}
                  strokeWidth={selected ? 2.5 : 1.5}
                />
                <text
                  x={p.x}
                  y={p.y + p.r + 13}
                  textAnchor="middle"
                  fontSize={10.5}
                  fontWeight={selected ? 700 : 500}
                  fill="#334155"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}
