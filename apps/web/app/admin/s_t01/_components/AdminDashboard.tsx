/**
 * S-T01 運営ダッシュボード — T-UC-30 / F-VIS 是正
 *
 * モック 06_mockups/admin/S-T01-dashboard.html のメインコンテンツ
 * (KPI bento タイル + アクティビティ / 監査ログ card) に忠実な描画。
 * props (kpis / recent) は不変で、実データを bento/activity 構成へバインドする。
 * モックの mission ヒーロー・トレンドグラフ等はダミー業務数値のため再現せず、
 * 実データが供給される KPI と 監査ログ由来アクティビティのみ mock 忠実に組む。
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";

export interface AdminKpi {
  readonly id: string;
  readonly label: string;
  readonly value: number | string;
}

export interface AdminActivity {
  readonly id: string;
  readonly ts: string;
  readonly action: string;
  readonly actor: string;
}

export interface AdminDashboardProps {
  readonly kpis: readonly AdminKpi[];
  readonly recent: readonly AdminActivity[];
}

/** action 文字列から活動カテゴリ・配色を導出 (モックの activity-list icon tone に対応)。 */
interface ActivityMeta {
  readonly category: string;
  readonly chip: string;
  readonly pill: string;
}

function activityMeta(action: string): ActivityMeta {
  const a = action.toLowerCase();
  if (/(create|signup|invite|register|add|join)/.test(a)) {
    return {
      category: "作成",
      chip: "bg-tertiary-container text-on-tertiary-container",
      pill: "bg-tertiary-container text-on-tertiary-container",
    };
  }
  if (/(delete|remove|churn|suspend|withdraw|revoke)/.test(a)) {
    return {
      category: "削除",
      chip: "bg-error/10 text-error",
      pill: "bg-error/10 text-error",
    };
  }
  if (/(skill|knowledge|publish|update|upgrade|deploy)/.test(a)) {
    return {
      category: "更新",
      chip: "bg-secondary-container text-on-secondary-container",
      pill: "bg-secondary-container text-on-secondary-container",
    };
  }
  return {
    category: "操作",
    chip: "bg-primary-container text-on-primary-container",
    pill: "bg-primary-container text-on-primary-container",
  };
}

function KpiTile({ kpi }: { readonly kpi: AdminKpi }) {
  return (
    <article className="relative overflow-hidden rounded-lg border border-border bg-white p-5">
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-on-surface-variant">
        {kpi.label}
      </div>
      <div className="text-[28px] font-bold leading-none tracking-tight tabular-nums text-on-surface">
        {kpi.value}
      </div>
    </article>
  );
}

function ActivityRow({ item }: { readonly item: AdminActivity }) {
  const meta = activityMeta(item.action);
  return (
    <li className="grid grid-cols-[28px_1fr_auto] items-start gap-3 border-b border-border py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-md",
          meta.chip,
        )}
      >
        <span className="h-2 w-2 rounded-full bg-current" />
      </span>
      <div className="min-w-0 text-[13px] leading-relaxed text-on-surface">
        <span className="font-bold">{item.actor}</span>
        <span className="text-on-surface-variant"> · </span>
        <span className="break-all font-mono text-[12.5px]">{item.action}</span>
        <span
          className={cn(
            "ml-2 inline-flex items-center rounded-full px-2 py-[1px] text-[10.5px] font-semibold align-middle",
            meta.pill,
          )}
        >
          {meta.category}
        </span>
      </div>
      <time className="whitespace-nowrap text-[11px] tabular-nums text-on-surface-variant">
        {item.ts}
      </time>
    </li>
  );
}

export function AdminDashboard({ kpis, recent }: AdminDashboardProps) {
  return (
    <div className="flex flex-col gap-6">
      {/* ━━━━━━ ヘッダー ━━━━━━ */}
      <header className="flex flex-col gap-1">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Platform Overview
        </span>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center rounded-sm bg-error px-2.5 py-[3px] text-[10px] font-extrabold tracking-[0.08em] text-on-error">
            運営
          </span>
          <h1 className="text-3xl font-bold tracking-tight text-on-surface">
            運営ダッシュボード
          </h1>
        </div>
      </header>

      {/* ━━━━━━ KPI bento ━━━━━━ */}
      <section
        aria-label="KPI"
        className="grid grid-cols-2 gap-4 md:grid-cols-4"
      >
        {kpis.map((k) => (
          <KpiTile key={k.id} kpi={k} />
        ))}
      </section>

      {/* ━━━━━━ アクティビティ (監査ログ) card ━━━━━━ */}
      <section
        aria-label="最近のアクティビティ"
        className="rounded-lg border border-border bg-white p-5"
      >
        <div className="mb-4 flex items-center gap-2.5">
          <h2 className="text-base font-bold text-on-surface">
            最近のアクティビティ
          </h2>
          <span className="ml-auto text-[11.5px] text-on-surface-variant">
            監査ログ · 直近
          </span>
        </div>
        {recent.length === 0 ? (
          <p className="py-12 text-center text-on-surface-variant">
            アクティビティはまだありません
          </p>
        ) : (
          <ul role="list" className="flex flex-col">
            {recent.map((a) => (
              <ActivityRow key={a.id} item={a} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
