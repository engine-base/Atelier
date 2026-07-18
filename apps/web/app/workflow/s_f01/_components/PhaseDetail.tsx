/**
 * PhaseDetail — S-F01 の選択工程ヘッダー + タブ (成果物/議論中/関連タスク) + 右レール
 * (モック .stage-header / .tabs-row / .side-card 準拠)
 *
 * データは実 API から container が取得して渡す。決定事項/未確認タブは
 * バックエンド (decisions テーブル) 未実装のため本 MVP では出さない — gap tracker 対象。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import {
  Check,
  ExternalLink,
  FileText,
  GitBranch,
  Kanban,
  LayoutDashboard,
  MessageSquare,
  Plus,
} from "lucide-react";

import { cn } from "../../../../lib/cn";
import type { StageNode } from "./StageBar";

/* ------------------------------------------------------------------ */
/* 型 (container が実 API レスポンスから詰める)                          */
/* ------------------------------------------------------------------ */

export interface PhaseOutput {
  readonly id: string;
  readonly summary: string | null;
  readonly stage: string;
  readonly version: number;
  readonly created_at?: string;
  readonly phase_id?: string | null;
}

export interface PhaseThread {
  readonly id: string;
  readonly title: string | null;
  readonly employeeName?: string;
  readonly employeeColor?: string;
  readonly updated_at?: string;
}

export interface PhaseTask {
  readonly id: string;
  readonly title: string;
  readonly priority?: string;
  readonly lifecycle_stage?: string;
  readonly status?: string;
}

export interface PhaseInfo {
  readonly id: string;
  readonly label: string;
  readonly status: StageNode["status"];
  readonly index: number; // 0-based
  readonly total: number;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
}

/* ------------------------------------------------------------------ */
/* 共通ヘルパー                                                        */
/* ------------------------------------------------------------------ */

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function elapsedLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const start = new Date(iso).getTime();
  if (Number.isNaN(start)) return "";
  const mins = Math.max(0, Math.floor((Date.now() - start) / 60000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `経過 ${days}日 ${hours}時間`;
  return `経過 ${String(hours).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

const STATUS_BADGE: Record<StageNode["status"], { label: string; cls: string }> = {
  done: { label: "完了済", cls: "bg-tertiary-container text-on-tertiary-container" },
  in_progress: { label: "進行中", cls: "bg-primary text-on-primary" },
  pending: { label: "未着手", cls: "bg-surface-variant text-on-surface-variant" },
  blocked: { label: "ブロック", cls: "bg-error text-on-error" },
};

/* ------------------------------------------------------------------ */
/* 工程ヘッダー (モック .stage-header)                                  */
/* ------------------------------------------------------------------ */

export function StageHeader({
  phase,
  progressPct,
}: {
  readonly phase: PhaseInfo;
  readonly progressPct: number;
}) {
  const badge = STATUS_BADGE[phase.status];
  return (
    <div className="bg-gradient-to-b from-primary-container to-transparent px-md pb-5 pt-6 sm:px-[32px]">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.14em] text-primary">
        <LayoutDashboard className="h-3 w-3" aria-hidden="true" />
        Stage {phase.index + 1} / {phase.total} · {phase.label} 工程
      </div>
      <h1 className="mb-[6px] text-[26px] font-bold tracking-[-0.02em] text-on-primary-container">
        {phase.label}
      </h1>
      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2 text-[13px] text-on-primary-container">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-[10px] py-[2px] text-[11px] font-bold",
            badge.cls,
          )}
        >
          {badge.label}
        </span>
        <div
          role="progressbar"
          aria-label="全体進捗"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-[6px] max-w-[320px] flex-1 basis-[180px] overflow-hidden rounded-full bg-white/50"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <span className="text-[12px] tabular-nums">全体 {progressPct}%</span>
        {phase.started_at ? (
          <span className="tabular-nums sm:ml-auto">
            開始 {fmtDateTime(phase.started_at)}
            {phase.status === "in_progress" ? ` · ${elapsedLabel(phase.started_at)}` : ""}
            {phase.completed_at ? ` · 完了 ${fmtDateTime(phase.completed_at)}` : ""}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* タブ (モック .tabs-row)                                             */
/* ------------------------------------------------------------------ */

type TabKey = "outputs" | "discussion" | "tasks";

const TAB_DEFS: readonly { key: TabKey; label: string }[] = [
  { key: "outputs", label: "成果物" },
  { key: "discussion", label: "議論中" },
  { key: "tasks", label: "関連タスク" },
];

function EmptyState({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-white px-md py-xl text-center text-[13px] text-on-surface-variant">
      {children}
    </div>
  );
}

export function PhaseTabs({
  projectId,
  outputs,
  threads,
  tasks,
}: {
  readonly projectId: string;
  readonly outputs: readonly PhaseOutput[];
  readonly threads: readonly PhaseThread[];
  readonly tasks: readonly PhaseTask[];
}) {
  const [active, setActive] = useState<TabKey>("outputs");
  const counts: Record<TabKey, number> = {
    outputs: outputs.length,
    discussion: threads.length,
    tasks: tasks.length,
  };

  return (
    <section aria-label="工程の詳細">
      <div
        role="tablist"
        aria-label="工程の内容"
        className="mb-[18px] flex gap-[2px] overflow-x-auto border-b border-border"
      >
        {TAB_DEFS.map((tabDef) => {
          const selected = active === tabDef.key;
          return (
            <button
              key={tabDef.key}
              type="button"
              role="tab"
              id={`tab-${tabDef.key}`}
              aria-selected={selected}
              aria-controls={`panel-${tabDef.key}`}
              onClick={() => setActive(tabDef.key)}
              className={cn(
                "flex items-center gap-[6px] whitespace-nowrap border-b-2 px-4 py-[10px] text-[13px] font-semibold transition-colors",
                selected
                  ? "border-primary text-primary"
                  : "border-transparent text-on-surface-variant hover:text-on-surface",
              )}
            >
              {tabDef.label}
              <span
                className={cn(
                  "rounded-full px-[7px] py-[1px] text-[10.5px] font-bold",
                  selected
                    ? "bg-primary-container text-on-primary-container"
                    : "bg-surface-variant text-on-surface-variant",
                )}
              >
                {counts[tabDef.key]}
              </span>
            </button>
          );
        })}
      </div>

      {/* 成果物 */}
      <div
        role="tabpanel"
        id="panel-outputs"
        aria-labelledby="tab-outputs"
        hidden={active !== "outputs"}
      >
        {outputs.length === 0 ? (
          <EmptyState>
            この工程の成果物はまだありません。AI 社員が作業を進めるとここに成果物が届きます。
          </EmptyState>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {outputs.map((o) => (
              <div
                key={o.id}
                className="rounded-md border border-border bg-white px-[14px] py-3 transition-shadow hover:shadow-[0_1px_3px_rgba(15,23,42,0.06)]"
              >
                <div className="mb-1 flex items-center gap-2">
                  <FileText className="h-[13px] w-[13px] shrink-0 text-on-surface-variant" aria-hidden="true" />
                  <strong className="truncate text-[13px] font-semibold text-on-surface">
                    {o.summary ?? o.stage ?? "成果物"}
                  </strong>
                </div>
                <div className="text-[12px] text-on-surface-variant">
                  v{o.version ?? 1}
                  {o.created_at ? ` · ${fmtDateTime(o.created_at)}` : ""}
                </div>
                <div className="mt-2">
                  <Link
                    href={`/outputs?project=${projectId}&output=${o.id}`}
                    className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    ビューアで開く
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 議論中 */}
      <div
        role="tabpanel"
        id="panel-discussion"
        aria-labelledby="tab-discussion"
        hidden={active !== "discussion"}
      >
        {threads.length === 0 ? (
          <EmptyState>進行中の議論はありません。</EmptyState>
        ) : (
          <div className="flex flex-col gap-[6px]">
            {threads.map((th) => (
              <Link
                key={th.id}
                href={`/chat?project=${projectId}&thread=${th.id}`}
                className="flex items-center gap-3 rounded-md border border-border bg-white px-[14px] py-3 transition-colors hover:border-primary hover:bg-surface-variant"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white"
                  style={{ backgroundColor: th.employeeColor ?? "#2563EB" }}
                >
                  {(th.employeeName ?? "A").charAt(0)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-on-surface">
                    {th.title ?? "無題スレッド"}
                  </span>
                  <span className="block text-[11.5px] text-on-surface-variant">
                    {th.employeeName ?? "AI社員"}
                    {th.updated_at ? ` · ${fmtDateTime(th.updated_at)}` : ""}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        )}
        <Link
          href={`/chat?project=${projectId}`}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-white px-4 py-[10px] text-[13px] font-semibold text-on-surface transition-colors hover:border-primary hover:text-primary"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          この工程で新規チャット
        </Link>
      </div>

      {/* 関連タスク */}
      <div
        role="tabpanel"
        id="panel-tasks"
        aria-labelledby="tab-tasks"
        hidden={active !== "tasks"}
      >
        {tasks.length === 0 ? (
          <EmptyState>このプロジェクトのタスクはまだありません。</EmptyState>
        ) : (
          <div className="flex flex-col gap-[6px]">
            {tasks.map((task) => (
              <Link
                key={task.id}
                href={`/tasks?project=${projectId}`}
                className="flex items-center gap-3 rounded-md border border-border bg-white px-[14px] py-[10px] transition-colors hover:border-primary"
              >
                <Kanban className="h-4 w-4 shrink-0 text-on-surface-variant" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-on-surface">
                  {task.title ?? "—"}
                </span>
                {task.priority ? (
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-[1px] text-[10.5px] font-bold",
                      task.priority === "critical" || task.priority === "high"
                        ? "bg-error/10 text-error"
                        : "bg-surface-variant text-on-surface-variant",
                    )}
                  >
                    {task.priority}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 右レール (モック .side-card)                                        */
/* ------------------------------------------------------------------ */

function SideCard({
  title,
  children,
  muted = false,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "mb-[14px] rounded-lg px-[18px] py-4",
        muted ? "bg-surface-variant" : "border border-border bg-white",
      )}
    >
      <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
        {title}
      </div>
      {children}
    </div>
  );
}

export interface SideRailProps {
  readonly projectId: string;
  readonly currentPhase?: PhaseInfo;
  /** 進行中工程の次 (クイックアクションのボタン文言用) */
  readonly hasNext?: boolean;
  /** 選択工程の次 (「次工程への引き継ぎ予告」カード用) */
  readonly nextPhaseLabel?: string;
  readonly prevPhaseLabel?: string;
  readonly prevSummary?: string;
  readonly threadCount: number;
  readonly taskCount: number;
  readonly onComplete?: () => void;
  readonly completing?: boolean;
}

export function SideRail({
  projectId,
  currentPhase,
  hasNext = false,
  nextPhaseLabel,
  prevPhaseLabel,
  prevSummary,
  threadCount,
  taskCount,
  onComplete,
  completing = false,
}: SideRailProps) {
  const linkRow =
    "flex items-center gap-2 border-b border-border py-[6px] text-[12.5px] last:border-b-0";
  const quickBtn =
    "mb-[6px] flex w-full items-center gap-2 rounded-md bg-surface-variant px-3 py-[10px] text-left text-[12.5px] font-semibold text-on-surface transition-colors hover:bg-primary-container hover:text-on-primary-container";

  return (
    <aside aria-label="工程のサイド情報">
      <SideCard title="クイックアクション">
        {onComplete && currentPhase?.status === "in_progress" ? (
          <button type="button" onClick={onComplete} disabled={completing} className={cn(quickBtn, "disabled:opacity-50")}>
            <Check className="h-[14px] w-[14px]" aria-hidden="true" />
            {completing
              ? "更新中…"
              : hasNext
                ? "この工程を完了して次へ"
                : "この工程を完了"}
          </button>
        ) : null}
        <Link href={`/chat?project=${projectId}`} className={quickBtn}>
          <MessageSquare className="h-[14px] w-[14px]" aria-hidden="true" />
          AI社員と議論する
        </Link>
        <Link href={`/workflow/phases?project=${projectId}`} className={quickBtn}>
          <GitBranch className="h-[14px] w-[14px]" aria-hidden="true" />
          フェーズ管理を開く
        </Link>
      </SideCard>

      <SideCard title="関連リンク">
        <div className={linkRow}>
          <Link
            href={`/chat?project=${projectId}`}
            className="flex flex-1 items-center gap-[6px] text-on-surface hover:text-primary"
          >
            <MessageSquare className="h-[14px] w-[14px]" aria-hidden="true" />
            進行中チャット
          </Link>
          <span className="text-[11.5px] tabular-nums text-on-surface-variant">
            {threadCount} 件
          </span>
        </div>
        <div className={linkRow}>
          <Link
            href={`/tasks?project=${projectId}`}
            className="flex flex-1 items-center gap-[6px] text-on-surface hover:text-primary"
          >
            <Kanban className="h-[14px] w-[14px]" aria-hidden="true" />
            関連タスク
          </Link>
          <span className="text-[11.5px] tabular-nums text-on-surface-variant">
            {taskCount} 件
          </span>
        </div>
        <div className={linkRow}>
          <Link
            href={`/outputs?project=${projectId}`}
            className="flex flex-1 items-center gap-[6px] text-on-surface hover:text-primary"
          >
            <ExternalLink className="h-[14px] w-[14px]" aria-hidden="true" />
            成果物ビューア
          </Link>
          <span className="text-[11.5px] text-on-surface-variant">→</span>
        </div>
      </SideCard>

      {prevPhaseLabel ? (
        <SideCard title="前工程から引き継いだサマリー">
          <div className="text-[13px] leading-[1.65] text-on-surface">
            {prevSummary ? (
              prevSummary
            ) : (
              <span className="text-on-surface-variant">
                {prevPhaseLabel} 工程の成果物サマリーはまだありません。
              </span>
            )}
          </div>
        </SideCard>
      ) : null}

      {nextPhaseLabel ? (
        <SideCard title="次工程への引き継ぎ予告" muted>
          <div className="text-[13px] leading-[1.65] text-on-surface">
            この工程の完了時に <strong>{nextPhaseLabel}</strong> 工程へ成果物と
            確定事項が自動で引き継がれます。
          </div>
        </SideCard>
      ) : null}
    </aside>
  );
}
