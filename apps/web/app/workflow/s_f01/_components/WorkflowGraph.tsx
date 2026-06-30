/**
 * S-F01 工程ワークフロー (司令塔) — T-UC-10
 *
 * - phases (フェーズ) を node、deps を edge として簡易グラフ表示
 * - 実 graph 描画は将来 react-flow を導入予定 (T-A-XX で別タスク)。
 *   本コンポーネントは AC「nodes/edges を表示」を満たす最小実装。
 */

"use client";

import * as React from "react";

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

const STATUS_BG: Record<PhaseNode["status"], string> = {
  pending: "bg-surface-variant text-on-surface-variant",
  in_progress: "bg-primary-container text-primary-container-fg",
  done: "bg-tertiary-container text-tertiary-container-fg",
  blocked: "bg-error/10 text-error",
};

const STATUS_LABEL: Record<PhaseNode["status"], string> = {
  pending: "未着手",
  in_progress: "進行中",
  done: "完了",
  blocked: "ブロック",
};

export function WorkflowGraph({ nodes, edges }: WorkflowGraphProps) {
  return (
    <section aria-label="工程ワークフロー" className="flex flex-col gap-md">
      <div className="flex flex-wrap gap-md">
        {nodes.map((n) => (
          <article
            key={n.id}
            className={cn(
              "flex min-w-32 flex-col gap-xs rounded-md px-md py-sm shadow-[var(--shadow-e1)]",
              STATUS_BG[n.status],
            )}
          >
            <span className="text-label-md">{STATUS_LABEL[n.status]}</span>
            <span className="text-body-md font-semibold">{n.label}</span>
          </article>
        ))}
      </div>
      <ul
        aria-label="依存関係"
        className="flex flex-col gap-xs text-label-md text-on-surface-variant"
      >
        {edges.map((e, i) => (
          <li key={i}>
            {nodes.find((n) => n.id === e.from)?.label ?? e.from} →{" "}
            {nodes.find((n) => n.id === e.to)?.label ?? e.to}
          </li>
        ))}
      </ul>
    </section>
  );
}
