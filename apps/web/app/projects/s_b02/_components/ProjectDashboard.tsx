/**
 * S-B02 プロジェクトダッシュボード — T-UC-04 / F-VIS 是正 (client component)
 *
 * モック 06_mockups/project/S-B02-dashboard.html に忠実な本文:
 *   - page header (eyebrow + プロジェクト名 見出し + サブタイトル)
 *   - KPI タイルグリッド (純白カード + uppercase ラベル + 大数値)
 * presentational（props で KPI を受ける）。実 API 配線は ProjectDashboardContainer が担う。
 */

"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { Skeleton } from "../../../../components/Skeleton";
import { cn } from "../../../../lib/cn";

export interface DashboardKpi {
  readonly id: string;
  readonly label: string;
  readonly value: number | string;
  readonly tone?: "info" | "success" | "error";
}

export interface ProjectDashboardProps {
  readonly projectName: string;
  /** current_phase (hearing / ... / delivery)。工程フローの現在地に使う。 */
  readonly currentPhase?: string;
  readonly kpis: readonly DashboardKpi[];
  readonly loading?: boolean;
}

/** モックの「工程の流れ（9 工程）」に対応する canonical 9 工程。 */
const PHASES: readonly { key: string; label: string }[] = [
  { key: "hearing", label: "ヒアリング" },
  { key: "requirements", label: "要件定義" },
  { key: "architecture", label: "アーキ設計" },
  { key: "design", label: "デザイン" },
  { key: "breakdown", label: "機能分解" },
  { key: "tasks", label: "タスク分解" },
  { key: "implementation", label: "実装" },
  { key: "verification", label: "検証" },
  { key: "delivery", label: "納品" },
];

// ラベルを tone 色 (例 error #DC2626 on tinted 面 = 4.05) にすると AA(4.5) を割る実バグが
// axe 実機で出たため、ラベルは中立色・数値 (28px bold, AA=3.0) のみ tone アクセント色。
const TONE_TEXT: Record<NonNullable<DashboardKpi["tone"]>, string> = {
  info: "text-on-surface",
  success: "text-tertiary-container-fg",
  error: "text-error",
};

export function ProjectDashboard({
  projectName,
  currentPhase,
  kpis,
  loading,
}: ProjectDashboardProps) {
  const currentIdx = Math.max(
    0,
    PHASES.findIndex((p) => p.key === currentPhase),
  );
  return (
    <div className="flex flex-col gap-xl">
      <header className="flex flex-col gap-2">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Project Dashboard
        </span>
        <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em] text-on-surface">
          {projectName}
        </h1>
        <p className="text-body-sm text-on-surface-variant">
          プロジェクトダッシュボード
        </p>
      </header>

      <section
        aria-label="KPI 一覧"
        className="grid grid-cols-2 gap-md md:grid-cols-3 xl:grid-cols-5"
      >
        {loading
          ? Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} height={92} className="w-full rounded-lg" />
            ))
          : kpis.map((k) => (
              <article
                key={k.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-white p-md"
              >
                <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-on-surface-variant">
                  {k.label}
                </span>
                <span
                  className={cn(
                    "text-[28px] font-bold leading-none tracking-[-0.02em] tabular-nums",
                    TONE_TEXT[k.tone ?? "info"],
                  )}
                >
                  {k.value}
                </span>
              </article>
            ))}
      </section>

      {/* 工程の流れ（9 工程） */}
      <section aria-label="工程の流れ" className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-on-surface">工程の流れ（9 工程）</h2>
          <span className="text-[12px] font-semibold text-on-surface-variant">
            第 {currentIdx + 1} 段階 / 9
          </span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border bg-white px-6 py-6">
          <ol className="flex min-w-[720px] items-start justify-between gap-2">
            {PHASES.map((p, i) => {
              const state = i < currentIdx ? "done" : i === currentIdx ? "current" : "todo";
              return (
                <li key={p.key} className="flex flex-1 flex-col items-center gap-2 text-center">
                  <span
                    className={cn(
                      "inline-flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-bold",
                      state === "done" && "bg-tertiary text-on-tertiary",
                      state === "current" &&
                        "bg-primary text-on-primary ring-4 ring-primary-container",
                      state === "todo" && "bg-surface-variant text-on-surface-variant",
                    )}
                  >
                    {state === "done" ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
                  </span>
                  <span
                    className={cn(
                      "text-[12px] font-semibold",
                      state === "todo" ? "text-on-surface-variant" : "text-on-surface",
                    )}
                  >
                    {p.label}
                  </span>
                  <span className="text-[10.5px] text-on-surface-variant">
                    {state === "done" ? "完了" : state === "current" ? "進行中" : "待機"}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </section>
    </div>
  );
}
