/**
 * S-E01 工程文脈バー — T-UC-09
 *
 * チャットの上部に現在の「工程 (phase)」を表示し、AI 社員が文脈を理解する。
 * phase change で AI に context を渡す callback も提供。
 */

"use client";

import * as React from "react";
import { ArrowRight, Workflow } from "lucide-react";

import { cn } from "../../../../lib/cn";

export interface ProcessContextBarProps {
  readonly phases: readonly string[];
  readonly currentPhaseId: string;
  /** 指定時のみ工程をクリックで切替可能。未指定なら読み取り専用(実 current_phase の反映)。 */
  readonly onChange?: (phaseId: string) => void;
  readonly className?: string;
}

export function ProcessContextBar({
  phases,
  currentPhaseId,
  onChange,
  className,
}: ProcessContextBarProps) {
  const currentIndex = Math.max(0, phases.indexOf(currentPhaseId));

  return (
    <nav
      aria-label="工程文脈"
      className={cn(
        "flex items-center gap-sm overflow-x-auto rounded-md bg-primary-container px-md py-xs text-on-primary-container",
        className,
      )}
    >
      <Workflow size={14} aria-hidden="true" className="shrink-0" />
      <span className="shrink-0 text-[11.5px] font-bold">現在の工程</span>
      <span className="shrink-0 text-[11.5px] opacity-75 tabular-nums">
        · Stage {currentIndex + 1} / {phases.length}
      </span>
      <ul role="list" className="flex gap-xs">
        {phases.map((p) => {
          const active = p === currentPhaseId;
          const cls = cn(
            "inline-flex h-7 items-center rounded-full px-sm text-[11px] font-semibold transition-colors",
            active
              ? "bg-primary text-on-primary"
              : "bg-white/40 text-on-primary-container",
          );
          return (
            <li key={p}>
              {onChange ? (
                <button
                  type="button"
                  onClick={() => onChange(p)}
                  aria-current={active ? "true" : undefined}
                  className={cn(cls, !active && "hover:bg-white/70")}
                >
                  {p}
                </button>
              ) : (
                <span aria-current={active ? "true" : undefined} className={cls}>
                  {p}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <span className="ml-auto hidden shrink-0 items-center gap-1 text-[11px] font-semibold opacity-90 sm:inline-flex">
        工程画面で全体を見る
        <ArrowRight size={11} aria-hidden="true" />
      </span>
    </nav>
  );
}
