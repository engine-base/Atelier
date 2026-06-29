/**
 * S-B02 プロジェクトダッシュボード — T-UC-04 (client component)
 *
 * 主要 KPI ティル + 直近タスクサマリ + チャットへのショートカット。
 * 実 API 連携は別 PR で TanStack Query で接続。
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
  info: "bg-surface-variant text-on-surface",
  success: "bg-tertiary-container text-tertiary-container-fg",
  error: "bg-error/10 text-error",
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
                <span className="text-label-md">{k.label}</span>
                <span className="text-headline-md font-bold">{k.value}</span>
              </article>
            ))}
      </section>
    </div>
  );
}
