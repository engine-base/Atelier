/**
 * S-F01 工程ワークフロー (司令塔) — T-UC-10
 *
 * モック 06_mockups/workflow/S-F01-flow.html の「9工程フローバー」に忠実な
 * 工程グラフを描画する。工程ノード(円 + 名称 + 状態) を順序どおり横並びにし、
 * ノード間を接続線で結ぶ。下に状態凡例(state pill)と工程の順序(依存関係)を置く。
 *
 * データはモックのダミー値ではなく実 API 由来の nodes / edges (props) にバインドする。
 * 実 graph 描画(react-flow 等) は将来別タスク。
 */

"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "../../../../lib/cn";

export interface PhaseNode {
  readonly id: string;
  readonly label: string;
  readonly status: "pending" | "in_progress" | "done" | "blocked";
}

export interface PhaseEdge {
  readonly from: string;
  readonly to: string;
}

export interface WorkflowGraphProps {
  readonly nodes: readonly PhaseNode[];
  readonly edges: readonly PhaseEdge[];
}

const STATUS_LABEL: Record<PhaseNode["status"], string> = {
  pending: "未着手",
  in_progress: "進行中",
  done: "完了",
  blocked: "ブロック",
};

/** ノード円 (stage-circle) の状態別スタイル。モック .stage-node.done/.current を踏襲。 */
const CIRCLE_STYLE: Record<PhaseNode["status"], string> = {
  pending: "border-border bg-surface-variant text-on-surface-variant",
  in_progress:
    "border-primary bg-primary text-on-primary ring-[3px] ring-primary-container",
  done: "border-tertiary bg-tertiary text-on-tertiary",
  blocked: "border-error bg-error/10 text-error",
};

/** ノード間の接続線 (::after) の状態別色。done=tertiary, current=gradient。 */
const CONNECTOR_STYLE: Record<PhaseNode["status"], string> = {
  pending: "bg-border",
  in_progress: "bg-gradient-to-r from-primary to-border",
  done: "bg-tertiary",
  blocked: "bg-border",
};

/** 状態凡例 (state pill)。件数は実 nodes から集計してバインドする。 */
const LEGEND: ReadonlyArray<{
  readonly status: PhaseNode["status"];
  readonly label: string;
  readonly dot: string;
  readonly tone: string;
}> = [
  {
    status: "done",
    label: "完了",
    dot: "bg-tertiary",
    tone: "bg-tertiary-container text-tertiary-container-fg",
  },
  {
    status: "in_progress",
    label: "進行中",
    dot: "bg-primary",
    tone: "bg-primary-container text-primary-container-fg",
  },
  {
    status: "pending",
    label: "未着手",
    dot: "bg-on-surface-variant",
    tone: "bg-surface-variant text-on-surface-variant",
  },
  {
    status: "blocked",
    label: "ブロック",
    dot: "bg-error",
    tone: "bg-error/10 text-error",
  },
];

export function WorkflowGraph({ nodes, edges }: WorkflowGraphProps) {
  const nodeLabel = (id: string) =>
    nodes.find((n) => n.id === id)?.label ?? id;

  return (
    <section aria-label="工程ワークフロー" className="flex flex-col gap-lg">
      {/* 工程フローバー — 工程ノードを順序どおり横並びにし接続線で結ぶ */}
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <ol className="flex items-stretch gap-0 overflow-x-auto px-md py-md">
          {nodes.map((n, i) => (
            <li
              key={n.id}
              className="relative flex min-w-[96px] flex-1 flex-col items-center px-1 pt-1"
            >
              {i < nodes.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-[calc(50%+17px)] right-[calc(-50%+17px)] top-[20px] z-[1] h-0.5",
                    CONNECTOR_STYLE[n.status],
                  )}
                />
              ) : null}
              <div
                className={cn(
                  "relative z-[2] flex h-[34px] w-[34px] items-center justify-center rounded-full border-2 text-[12.5px] font-bold",
                  CIRCLE_STYLE[n.status],
                )}
              >
                {n.status === "done" ? (
                  <Check size={15} strokeWidth={3} aria-hidden="true" />
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={cn(
                  "mt-2 text-center text-[11.5px] font-bold leading-tight",
                  n.status === "in_progress"
                    ? "text-primary"
                    : "text-on-surface",
                )}
              >
                {n.label}
              </span>
              <span className="mt-0.5 text-center text-[10px] text-on-surface-variant">
                {STATUS_LABEL[n.status]}
              </span>
            </li>
          ))}
        </ol>
      </div>

      {/* 状態凡例 — 件数を実データから集計 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          凡例
        </span>
        {LEGEND.map((item) => {
          const count = nodes.filter((n) => n.status === item.status).length;
          return (
            <span
              key={item.status}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
                item.tone,
              )}
            >
              <span
                aria-hidden="true"
                className={cn("h-1.5 w-1.5 rounded-full", item.dot)}
              />
              <span className="tabular-nums">{`${item.label} ${count}`}</span>
            </span>
          );
        })}
      </div>

      {/* 工程の順序 — 依存エッジを from → to で列挙 */}
      <div className="rounded-lg border border-border bg-white p-md">
        <h2 className="mb-sm text-base font-bold text-on-surface">
          工程の順序
        </h2>
        <ul
          aria-label="依存関係"
          className="flex flex-col gap-1 text-body-sm text-on-surface-variant"
        >
          {edges.map((e, i) => (
            <li
              key={i}
              className="rounded-md bg-surface-variant/50 px-3 py-1.5 tabular-nums"
            >
              {nodeLabel(e.from)} → {nodeLabel(e.to)}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
