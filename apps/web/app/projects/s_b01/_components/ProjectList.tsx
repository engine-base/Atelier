/**
 * S-B01 プロジェクト一覧 — T-UC-03 / F-VIS-02 是正 (client component)
 *
 * モック 06_mockups/project/S-B01-list.html に忠実:
 *   ヘッダ(タイトル+件数+新規ボタン) → フィルタバー(検索+すべて/進行中/アーカイブ) →
 *   3列カードグリッド(種別バッジ+状態pill+名前+クライアント+9段フェーズ進捗+件数/更新) + 新規作成カード。
 * 検索・状態タブはクライアント側の実フィルタ。カードクリックで onSelect(id)、新規で onNew()。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { ListChecks, Plus, Search } from "lucide-react";

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
  /** 新規プロジェクト作成 (ヘッダボタン + 作成カード)。未指定なら作成 UI を出さない。 */
  readonly onNew?: () => void;
}

const TYPE_LABEL: Record<ProjectType, string> = {
  client_project: "クライアント案件",
  self_product: "自社プロダクト",
  personal: "個人開発",
};

const TYPE_BADGE: Record<ProjectType, string> = {
  client_project: "bg-primary-container text-on-primary-container",
  self_product: "bg-secondary-container text-on-secondary-container",
  personal: "bg-surface-variant text-on-surface-variant",
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

const PHASE_PILL: Record<string, { label: string; tone: string; dot: string }> = {
  hearing: { label: "ヒアリング中", tone: "bg-tertiary-container text-on-tertiary-container", dot: "bg-tertiary" },
  requirements: { label: "要件定義中", tone: "bg-tertiary-container text-on-tertiary-container", dot: "bg-tertiary" },
  architecture: { label: "設計中", tone: "bg-secondary-container text-on-secondary-container", dot: "bg-secondary" },
  design: { label: "設計中", tone: "bg-secondary-container text-on-secondary-container", dot: "bg-secondary" },
  breakdown: { label: "分解中", tone: "bg-secondary-container text-on-secondary-container", dot: "bg-secondary" },
  tasks: { label: "実装準備", tone: "bg-secondary-container text-on-secondary-container", dot: "bg-secondary" },
  implementation: { label: "実装中", tone: "bg-primary-container text-on-primary-container", dot: "bg-primary" },
  verification: { label: "検証中", tone: "bg-primary-container text-on-primary-container", dot: "bg-primary" },
  delivery: { label: "納品済", tone: "bg-tertiary-container text-on-tertiary-container", dot: "bg-tertiary" },
};

const LIFECYCLE_TABS = [
  { key: "all", label: "すべて" },
  { key: "active", label: "進行中" },
  { key: "archived", label: "アーカイブ" },
] as const;

type LifecycleTab = (typeof LIFECYCLE_TABS)[number]["key"];

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
    dot: "bg-on-surface-variant",
  };
  const doneUpto = phaseIndex(row.currentPhase);
  return (
    <button
      type="button"
      onClick={() => onSelect?.(row.id)}
      className={cn(
        "flex flex-col rounded-lg border border-border bg-white p-5 text-left shadow-sm",
        "transition-all duration-150 hover:-translate-y-px hover:border-primary hover:shadow-md",
        "focus-visible:outline-2 focus-visible:outline-primary",
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <span
          className={cn(
            "inline-flex items-center rounded-sm px-2 py-0.5 text-[10.5px] font-semibold",
            TYPE_BADGE[row.type],
          )}
        >
          {TYPE_LABEL[row.type]}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
            pill.tone,
          )}
        >
          <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", pill.dot)} />
          {pill.label}
        </span>
      </div>
      <h3 className="mb-1 text-lg font-bold text-on-surface">{row.name}</h3>
      <p className="mb-3 text-sm text-on-surface-variant">{row.client_name ?? "—"}</p>
      {/* 9 段フェーズ進捗 (モック .pj-phases) */}
      <div className="mb-3 flex gap-1" aria-hidden="true">
        {PHASE_ORDER.map((p, i) => (
          <span
            key={p}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i < doneUpto && "bg-tertiary",
              i === doneUpto && "bg-primary",
              i > doneUpto && "bg-surface-variant",
            )}
          />
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between text-sm text-on-surface-variant">
        <span className="inline-flex items-center gap-1 tabular-nums">
          <ListChecks className="h-3 w-3" aria-hidden="true" />
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
  onNew,
}: ProjectListProps) {
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<LifecycleTab>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab === "active" && r.lifecycle !== "active") return false;
      if (tab === "archived" && r.lifecycle !== "archived") return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.client_name ?? "").toLowerCase().includes(q) ||
        (PHASE_PILL[r.currentPhase]?.label ?? r.currentPhase).toLowerCase().includes(q)
      );
    });
  }, [rows, query, tab]);

  return (
    <div className="flex flex-col gap-6">
      {/* ヘッダ */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-on-surface">プロジェクト</h1>
          <p className="mt-1 text-sm text-on-surface-variant">
            {rows.filter((r) => r.lifecycle === "active").length} 件のアクティブプロジェクト
          </p>
        </div>
        {onNew ? (
          <button
            type="button"
            onClick={onNew}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            新規プロジェクト
          </button>
        ) : null}
      </div>

      {/* フィルタバー */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-white px-4 py-2.5">
        <label className="flex min-w-[220px] flex-1 items-center gap-2">
          <Search className="h-3.5 w-3.5 text-on-surface-variant" aria-hidden="true" />
          <span className="sr-only">プロジェクトを検索</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="プロジェクトを検索（名前 / クライアント / フェーズ）"
            className="w-full border-none bg-transparent text-body-md text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </label>
        <div className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
        <div
          role="tablist"
          aria-label="状態で絞り込み"
          className="inline-flex items-center gap-1 rounded-md bg-surface-variant p-1"
        >
          {LIFECYCLE_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-sm px-3 py-1 text-[12px] font-semibold transition-colors",
                tab === t.key
                  ? "bg-white text-on-surface shadow-sm"
                  : "text-on-surface-variant hover:text-on-surface",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-md bg-error/10 px-md py-sm text-body-sm text-error">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-lg border border-border bg-surface-variant/40"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-md py-lg text-center text-body-md text-on-surface-variant">
          プロジェクトがありません
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((r) => (
            <ProjectCard key={r.id} row={r} onSelect={onSelect} />
          ))}
          {onNew ? (
            <button
              type="button"
              onClick={onNew}
              className="flex min-h-[176px] flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border text-on-surface-variant transition-colors hover:border-primary hover:text-primary"
            >
              <Plus className="h-6 w-6" aria-hidden="true" />
              <span className="text-sm font-bold">新規プロジェクトを作成</span>
              <span className="text-[11px]">クライアント案件・自社プロダクト・個人開発</span>
            </button>
          ) : null}
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
