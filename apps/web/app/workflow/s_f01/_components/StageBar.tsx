/**
 * StageBar — S-F01 上部の 9 工程フローバー (モック .stage-bar 準拠)
 *
 * - done: tertiary丸 + check / current: primary丸 + ring / pending: outline丸
 * - ノード間コネクタ線 (done 区間は tertiary)
 * - クリックで工程を選択 (選択ノードは primary-container ハイライト)
 * - モバイル: 横スクロール (min-w 96px/ノード)
 */

"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "../../../../lib/cn";

export type StageStatus = "done" | "in_progress" | "pending" | "blocked";

export interface StageNode {
  readonly id: string;
  readonly label: string;
  readonly status: StageStatus;
}

const META_LABEL: Record<StageStatus, string> = {
  done: "完了",
  in_progress: "進行中",
  pending: "待機",
  blocked: "ブロック",
};

export interface StageBarProps {
  readonly nodes: readonly StageNode[];
  readonly selectedId?: string;
  readonly onSelect?: (id: string) => void;
}

export function StageBar({ nodes, selectedId, onSelect }: StageBarProps) {
  return (
    <div className="sticky top-14 z-[5] border-b border-border bg-white px-lg py-[14px]">
      <div
        role="tablist"
        aria-label="工程"
        className="flex items-stretch overflow-x-auto px-0 pb-[2px] pt-1"
      >
        {nodes.map((node, i) => {
          const selected = node.id === selectedId;
          const last = i === nodes.length - 1;
          return (
            <button
              key={node.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={`${node.label} (${META_LABEL[node.status]})`}
              onClick={() => onSelect?.(node.id)}
              className={cn(
                "relative flex min-w-[96px] flex-1 cursor-pointer flex-col items-center rounded-md px-1 pb-1 pt-1 transition-colors duration-100",
                "hover:bg-surface-variant",
                selected && "bg-primary-container hover:bg-primary-container",
              )}
            >
              {/* コネクタ線 (最後のノード以外)。done 区間は tertiary。 */}
              {!last ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-[calc(50%+17px)] right-[calc(-50%+17px)] top-[23px] z-[1] h-0.5",
                    node.status === "done" ? "bg-tertiary" : "bg-border",
                  )}
                />
              ) : null}

              {/* 丸 */}
              <span
                className={cn(
                  "relative z-[2] flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border-2 text-[12.5px] font-bold",
                  node.status === "done" &&
                    "border-tertiary bg-tertiary text-on-tertiary",
                  node.status === "in_progress" &&
                    "border-primary bg-primary text-on-primary shadow-[0_0_0_3px_#DBEAFE]",
                  node.status === "pending" &&
                    "border-border bg-surface-variant text-on-surface-variant",
                  node.status === "blocked" &&
                    "border-error bg-error text-on-error",
                )}
              >
                {node.status === "done" ? (
                  <Check className="h-[13px] w-[13px]" aria-hidden="true" strokeWidth={3} />
                ) : (
                  i + 1
                )}
              </span>

              <span
                className={cn(
                  "mt-2 text-center text-[11.5px] font-bold leading-tight",
                  node.status === "in_progress" ? "text-primary" : "text-on-surface",
                )}
              >
                {node.label}
              </span>
              <span
                className={cn(
                  "mt-[2px] text-center text-[10px] leading-tight",
                  selected ? "text-on-primary-container" : "text-on-surface-variant",
                )}
              >
                {META_LABEL[node.status]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
