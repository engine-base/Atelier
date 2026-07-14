/**
 * S-B02 プロジェクトダッシュボード — T-UC-04 (client component)
 *
 * 主要 KPI ティル + 直近タスクサマリ + チャットへのショートカット。
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

const TONE_BG: Record<NonNullable<DashboardKpi["tone"]>, string> = {
  info: "bg-surface-variant",
  success: "bg-tertiary-container",
  error: "bg-error/10",
};

// 12px ラベルを tone 色 (例 error #DC2626 on #fbe7e3 = 4.05) にすると AA(4.5) を
// 割る実バグが axe 実機で出たため、ラベルは中立色・数値(36px bold, AA=3.0) のみ tone 色。
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
    <div className="flex flex-col gap-lg">
      <header>
        <h1 className="text-headline-md font-bold text-on-surface">
          {projectName}
        </h1>
        <p className="text-body-md text-on-surface-variant">
          プロジェクトダッシュボード
        </p>
      </header>
      <section
        aria-label="KPI 一覧"
        className="grid grid-cols-1 gap-md md:grid-cols-2 lg:grid-cols-3"
      >
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={80} className="w-full" />
            ))
          : kpis.map((k) => (
              <article
                key={k.id}
                className={cn(
                  "flex flex-col gap-xs rounded-lg p-md",
                  TONE_BG[k.tone ?? "info"],
                )}
              >
                <span className="text-label-md text-on-surface-variant">
                  {k.label}
                </span>
                <span
                  className={cn(
                    "text-headline-md font-bold",
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
