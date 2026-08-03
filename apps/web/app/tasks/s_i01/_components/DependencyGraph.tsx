/**
 * S-I01 依存グラフビュー (GAP-006 解消)
 *
 * tasks.dependencies (前提タスク ID 配列) を層別 DAG として描画する。
 * - 層 = 前提からの最長距離 (トポロジカル深さ)。循環は検出して安全側 (層 0) に落とし
 *   バッジで明示する (黙って壊れない)。
 * - ノード座標は決定的に計算し、辺は SVG ベジェで前提ノード右端 → 依存ノード左端。
 *   DOM 計測に依存しないので JSDOM でも同じ構造が検証できる。
 * - ノードはタスク詳細 (/tasks/detail?task=) への実リンク。ステージ配色は凡例と同一。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import Link from "next/link";

import { cn } from "../../../../lib/cn";
import { STAGE_LABEL, type TaskCard } from "./KanbanBoard";

const NODE_W = 208;
const NODE_H = 62;
const GAP_X = 72;
const GAP_Y = 16;
const PAD = 16;

const STAGE_ACCENT: Record<string, string> = {
  backlog: "border-l-on-surface-variant",
  ready: "border-l-primary",
  in_progress: "border-l-tertiary",
  awaiting: "border-l-secondary",
  done: "border-l-[#16A34A]",
  blocked: "border-l-error",
};

interface GraphNode {
  readonly task: TaskCard;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly inCycle: boolean;
}

interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

/** 前提からの最長距離で層を割り当てる。循環ノードは layer 0 + inCycle。 */
export function layoutGraph(tasks: readonly TaskCard[]): {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  width: number;
  height: number;
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  // 辺 = 存在するタスク間の依存のみ (外部 ID は無視)
  const edges: GraphEdge[] = [];
  for (const t of tasks) {
    for (const dep of t.dependencies ?? []) {
      if (byId.has(dep)) edges.push({ from: dep, to: t.id });
    }
  }
  const depsOf = new Map<string, string[]>();
  for (const e of edges) depsOf.set(e.to, [...(depsOf.get(e.to) ?? []), e.from]);

  // 最長距離 (メモ化 DFS、訪問中スタックで循環検出)
  const layer = new Map<string, number>();
  const cyclic = new Set<string>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const memo = layer.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) {
      cyclic.add(id);
      return 0;
    }
    visiting.add(id);
    const ds = depsOf.get(id) ?? [];
    const d = ds.length === 0 ? 0 : Math.max(...ds.map((p) => depth(p) + 1));
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const t of tasks) depth(t.id);

  // 層ごとに行を割り当て (作成順のまま = tasks の並び順)
  const rows = new Map<number, number>();
  const nodes: GraphNode[] = tasks.map((t) => {
    const l = layer.get(t.id) ?? 0;
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    return {
      task: t,
      layer: l,
      row: r,
      x: PAD + l * (NODE_W + GAP_X),
      y: PAD + r * (NODE_H + GAP_Y),
      inCycle: cyclic.has(t.id),
    };
  });
  const maxLayer = nodes.reduce((m, n) => Math.max(m, n.layer), 0);
  const maxRows = Math.max(1, ...[...rows.values()]);
  return {
    nodes,
    edges,
    width: PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * GAP_X,
    height: PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y,
  };
}

export function DependencyGraph({ tasks }: { readonly tasks: readonly TaskCard[] }) {
  const { nodes, edges, width, height } = useMemo(() => layoutGraph(tasks), [tasks]);
  const pos = useMemo(() => new Map(nodes.map((n) => [n.task.id, n])), [nodes]);

  if (tasks.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-white px-4 py-10 text-center text-body-md text-on-surface-variant">
        タスクがありません。
      </p>
    );
  }

  return (
    <div
      className="overflow-x-auto rounded-lg border border-border bg-white"
      role="img"
      aria-label={`依存グラフ: タスク ${nodes.length} 件 / 依存 ${edges.length} 本`}
    >
      <div className="relative" style={{ width, height, minWidth: width }}>
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          width={width}
          height={height}
          data-testid="deps-edges"
        >
          {edges.map((e) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={`${e.from}-${e.to}`}
                data-testid="deps-edge"
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                className="stroke-on-surface-variant/50"
                strokeWidth={1.5}
                markerEnd="url(#deps-arrow)"
              />
            );
          })}
          <defs>
            <marker
              id="deps-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" className="fill-on-surface-variant/60" />
            </marker>
          </defs>
        </svg>
        {nodes.map((n) => (
          <Link
            key={n.task.id}
            href={`/tasks/detail?task=${n.task.id}`}
            className={cn(
              "absolute flex flex-col justify-center rounded-md border border-border border-l-[3px] bg-white px-3 py-2 shadow-sm transition-shadow hover:shadow-md",
              STAGE_ACCENT[n.task.stage] ?? "border-l-border",
            )}
            style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
          >
            <span className="truncate text-[12px] font-semibold leading-tight text-on-surface">
              {n.task.title}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-on-surface-variant">
              {STAGE_LABEL[n.task.stage]}
              {n.task.assignee ? ` · ${n.task.assignee}` : ""}
              {n.inCycle ? (
                <span className="rounded-full bg-[#FEE2E2] px-1.5 font-bold text-[#991B1B]">
                  循環依存
                </span>
              ) : null}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
