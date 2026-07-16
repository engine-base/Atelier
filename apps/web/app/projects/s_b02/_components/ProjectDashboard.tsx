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
  readonly kpis: readonly DashboardKpi[];
  readonly loading?: boolean;
}

// ラベルを tone 色 (例 error #DC2626 on tinted 面 = 4.05) にすると AA(4.5) を割る実バグが
// axe 実機で出たため、ラベルは中立色・数値 (28px bold, AA=3.0) のみ tone アクセント色。
const TONE_TEXT: Record<NonNullable<DashboardKpi["tone"]>, string> = {
  info: "text-on-surface",
  success: "text-tertiary-container-fg",
  error: "text-error",
};

export function ProjectDashboard({
  projectName,
  kpis,
  loading,
}: ProjectDashboardProps) {
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
    </div>
  );
}
