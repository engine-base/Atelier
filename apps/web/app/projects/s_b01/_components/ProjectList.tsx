/**
 * S-B01 プロジェクト一覧 — T-UC-03 / F-VIS-02 是正 (client component)
 *
 * モック 06_mockups/project/S-B01-list.html に忠実なカードグリッドで描画する。
 * カード = 種別バッジ + 工程 pill(dot) + プロジェクト名 + クライアント + 9段フェーズ進捗 + 更新時刻。
 * loading / error / empty 状態対応。カードクリックで onSelect(id) を発火。
 */

"use client";

import * as React from "react";

import { Pagination } from "../../../../components/data-table/Pagination";
import { cn } from "../../../../lib/cn";
import { formatDate } from "../../../../lib/i18n";

export type ProjectType = "client_project" | "self_product" | "personal";

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly client_name: string | null;
  readonly type: ProjectType;
  readonly lifecycle: "active" | "archived" | "paused";
  /** current_phase (hearing / requirements / ... / delivery)。進捗と pill に使う。 */
  readonly currentPhase: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProjectListProps {
  readonly rows: readonly ProjectRow[];
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly prevCursor: string | null;
  readonly nextCursor: string | null;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  readonly onSelect?: (id: string) => void;
}

const TYPE_LABEL: Record<ProjectType, string> = {
  client_project: "クライアント案件",
  self_product: "自社プロダクト",
  personal: "個人開発",
};

/** 9 工程の canonical 順 (モックのフェーズ進捗 9 セグメントに対応)。 */
const PHASE_ORDER = [
  "hearing",
  "requirements",
  "architecture",
  "design",
  "breakdown",
  "tasks",
  "implementation",
  "verification",
  "delivery",
] as const;

const PHASE_PILL: Record<string, { label: string; tone: string }> = {
  hearing: { label: "ヒアリング中", tone: "bg-tertiary-container text-tertiary-container-fg" },
  requirements: { label: "要件定義中", tone: "bg-tertiary-container text-tertiary-container-fg" },
  architecture: { label: "設計中", tone: "bg-secondary-container text-secondary-container-fg" },
  design: { label: "設計中", tone: "bg-secondary-container text-secondary-container-fg" },
  breakdown: { label: "分解中", tone: "bg-secondary-container text-secondary-container-fg" },
  tasks: { label: "実装準備", tone: "bg-secondary-container text-secondary-container-fg" },
  implementation: { label: "実装中", tone: "bg-primary-container text-primary-container-fg" },
  verification: { label: "検証中", tone: "bg-primary-container text-primary-container-fg" },
  delivery: { label: "納品済", tone: "bg-tertiary-container text-tertiary-container-fg" },
};

function phaseIndex(phase: string): number {
  const i = PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number]);
  return i < 0 ? 0 : i;
}

function ProjectCard({
  row,
  onSelect,
}: {
  readonly row: ProjectRow;
  readonly onSelect?: (id: string) => void;
}) {
  const pill = PHASE_PILL[row.currentPhase] ?? {
    label: row.currentPhase,
    tone: "bg-surface-variant text-on-surface-variant",
  };
  const doneUpto = phaseIndex(row.currentPhase);
  return (
    <button
      type="button"
      onClick={() => onSelect?.(row.id)}
      className={cn(
        "flex flex-col rounded-lg border border-surface-variant bg-surface p-md text-left",
        "shadow-sm transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-primary",
      )}
    >
      <div className="mb-sm flex items-center justify-between">
        <span className="rounded-full bg-primary-container px-sm py-[2px] text-label-sm font-semibold text-primary-container-fg">
          {TYPE_LABEL[row.type]}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-sm py-[2px] text-label-sm font-medium",
            pill.tone,
          )}
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
          {pill.label}
        </span>
      </div>
      <h3 className="mb-1 text-title-md font-bold text-on-surface">{row.name}</h3>
      <p className="mb-md text-body-sm text-on-surface-variant">{row.client_name ?? "—"}</p>
      {/* 9 段フェーズ進捗 */}
      <div className="mb-sm flex gap-1" aria-hidden="true">
        {PHASE_ORDER.map((p, i) => (
          <span
            key={p}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i < doneUpto && "bg-primary",
              i === doneUpto && "bg-primary/60",
              i > doneUpto && "bg-surface-variant",
            )}
          />
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between text-body-sm text-on-surface-variant">
        <span className="tabular-nums">
          工程 {doneUpto + 1} / {PHASE_ORDER.length}
        </span>
        <span className="tabular-nums">{formatDate(row.updated_at, "short-date")} 更新</span>
      </div>
    </button>
  );
}

export function ProjectList({
  rows,
  loading,
  error,
  prevCursor,
  nextCursor,
  onPrev,
  onNext,
  onSelect,
}: ProjectListProps) {
  return (
    <div className="flex flex-col gap-md">
      {error ? (
        <p role="alert" className="rounded-md bg-error/10 px-md py-sm text-body-sm text-error">
          読み込みに失敗しました。時間をおいて再試行してください。
        </p>
      ) : null}

      {loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-md">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-lg border border-surface-variant bg-surface-variant/40"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-surface-variant px-md py-lg text-center text-body-md text-on-surface-variant">
          プロジェクトがありません
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-md">
          {rows.map((r) => (
            <ProjectCard key={r.id} row={r} onSelect={onSelect} />
          ))}
        </div>
      )}

      <Pagination
        prevCursor={prevCursor}
        nextCursor={nextCursor}
        onPrev={onPrev}
        onNext={onNext}
        summary={rows.length > 0 ? `${rows.length} 件のプロジェクト` : undefined}
      />
    </div>
  );
}
