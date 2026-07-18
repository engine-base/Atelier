/**
 * PhaseDetail — S-F01 の選択工程ヘッダー + タブ + 右レール
 * (モック 06_mockups/workflow/S-F01-flow.html の
 *  .stage-header / .tabs-row / .decision-item / .preview-card / .thread-item /
 *  .unresolved-item / .side-card を実データで忠実再現)
 *
 * タブ構成はモックと同一: 確定事項 / 成果物 / 議論中 / 未確認 (+実装追加の関連タスク)。
 * 確定事項・未確認は /decisions API (T-D-101)、議論中は /chat/threads
 * (message_count 付き)、成果物は /outputs。
 */

"use client";

import * as React from "react";
import { useState } from "react";
import Link from "next/link";
import {
  Check,
  Download,
  ExternalLink,
  Eye,
  FileCode,
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
  readonly html_path?: string | null;
  readonly json_path?: string | null;
  readonly md_path?: string | null;
}

export interface PhaseThread {
  readonly id: string;
  readonly title: string | null;
  readonly employeeName?: string;
  readonly employeeColor?: string;
  readonly updated_at?: string;
  readonly messageCount?: number;
}

export interface PhaseTask {
  readonly id: string;
  readonly title: string;
  readonly priority?: string;
  readonly lifecycle_stage?: string;
  readonly status?: string;
}

export interface PhaseDecision {
  readonly id: string;
  readonly status: "decided" | "unresolved";
  readonly body: string;
  readonly reflected_to?: string | null;
  readonly resolve_note?: string | null;
  readonly created_at?: string;
  readonly employeeName?: string;
  readonly employeeColor?: string;
  readonly with_user?: boolean;
}

export interface PhaseEmployee {
  readonly id: string;
  readonly name: string;
  readonly color: string;
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

/** モックの「8 分前」「昨日」表示。 */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return "たった今";
  if (mins < 60) return `${mins} 分前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 時間前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨日";
  if (days < 7) return `${days} 日前`;
  return fmtDateTime(iso).slice(0, 10);
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

function EmployeeAvatar({
  name,
  color,
  size = 24,
}: {
  readonly name?: string;
  readonly color?: string;
  readonly size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.46),
        backgroundColor: color ?? "#2563EB",
      }}
    >
      {(name ?? "A").charAt(0)}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 工程ヘッダー (モック .stage-header)                                  */
/* ------------------------------------------------------------------ */

export function StageHeader({
  phase,
  progressPct,
  employees = [],
}: {
  readonly phase: PhaseInfo;
  readonly progressPct: number;
  readonly employees?: readonly PhaseEmployee[];
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
        {employees.map((emp) => (
          <span key={emp.id} className="flex items-center gap-2">
            <EmployeeAvatar name={emp.name} color={emp.color} />
            {emp.name}
          </span>
        ))}
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
/* タブ (モック .tabs-row / 4 タブ + 関連タスク)                        */
/* ------------------------------------------------------------------ */

type TabKey = "decisions" | "outputs" | "discussion" | "unresolved" | "tasks";

const TAB_DEFS: readonly { key: TabKey; label: string }[] = [
  { key: "decisions", label: "確定事項" },
  { key: "outputs", label: "成果物" },
  { key: "discussion", label: "議論中" },
  { key: "unresolved", label: "未確認" },
  { key: "tasks", label: "関連タスク" },
];

const DECISIONS_PREVIEW_COUNT = 6;

function EmptyState({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-white px-md py-xl text-center text-[13px] text-on-surface-variant">
      {children}
    </div>
  );
}

/** 確定事項 1 件 (モック .decision-item: tertiary の左ボーダー)。 */
function DecisionItem({ decision }: { readonly decision: PhaseDecision }) {
  return (
    <div className="rounded-md border border-border border-l-[3px] border-l-tertiary bg-white px-[18px] py-[14px] transition-shadow duration-100 hover:shadow-[0_1px_3px_rgba(15,23,42,0.06)]">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-on-surface-variant">
        <span className="inline-flex items-center rounded-full bg-tertiary-container px-2 py-[1px] text-[10.5px] font-bold text-on-tertiary-container">
          確定
        </span>
        <span className="tabular-nums">{fmtDateTime(decision.created_at)}</span>
        {decision.employeeName ? (
          <>
            <EmployeeAvatar name={decision.employeeName} color={decision.employeeColor} />
            <span>
              {decision.employeeName}
              {decision.with_user ? " + あなた" : ""}
            </span>
          </>
        ) : decision.with_user ? (
          <span>あなた</span>
        ) : null}
      </div>
      <div className="mb-1 text-[14px] font-semibold leading-[1.5] text-on-surface">
        {decision.body}
      </div>
      {decision.reflected_to ? (
        <div className="text-[12px] tabular-nums text-on-surface-variant">
          反映先：{decision.reflected_to}
        </div>
      ) : null}
    </div>
  );
}

/** 未確認 1 件 (モック .unresolved-item: secondary-container の警告行)。 */
function UnresolvedItem({ decision }: { readonly decision: PhaseDecision }) {
  return (
    <div className="mb-[6px] flex items-start gap-[10px] rounded-md bg-secondary-container px-[14px] py-[10px] text-on-secondary-container">
      <span
        aria-hidden="true"
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-bold text-on-secondary"
      >
        !
      </span>
      <div>
        <div className="text-[13px] font-semibold">{decision.body}</div>
        {decision.resolve_note ? (
          <div className="text-[13px] opacity-[0.85]">{decision.resolve_note}</div>
        ) : null}
      </div>
    </div>
  );
}

/** 成果物プレビュー (モック .preview-card: 形式タブ + doc プレビュー)。 */
function OutputPreviewCard({
  output,
  projectId,
}: {
  readonly output: PhaseOutput;
  readonly projectId: string;
}) {
  const formats = [
    { key: "html", label: "HTML", icon: Eye, available: !!output.html_path },
    { key: "json", label: "JSON", icon: FileCode, available: !!output.json_path },
    { key: "md", label: "MD", icon: FileText, available: !!output.md_path },
  ] as const;
  const first = formats.find((f) => f.available)?.key ?? "html";
  const [fmt, setFmt] = useState<string>(first);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-surface-variant px-3 py-2">
        {formats.map((f) => (
          <button
            key={f.key}
            type="button"
            disabled={!f.available}
            onClick={() => setFmt(f.key)}
            className={cn(
              "inline-flex items-center gap-1 rounded-[6px] px-3 py-[5px] text-[11.5px] font-semibold",
              fmt === f.key && f.available
                ? "bg-white text-on-surface shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                : "text-on-surface-variant",
              !f.available && "opacity-40",
            )}
          >
            <f.icon className="h-[11px] w-[11px]" aria-hidden="true" />
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1">
          <Link
            href={`/outputs?project=${projectId}&output=${output.id}`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-semibold text-on-surface-variant hover:bg-white hover:text-on-surface"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            全画面
          </Link>
          <Link
            href={`/outputs?project=${projectId}&output=${output.id}`}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-semibold text-on-surface-variant hover:bg-white hover:text-on-surface"
          >
            <Download className="h-3 w-3" aria-hidden="true" />
            DL
          </Link>
        </div>
      </div>
      <div className="max-h-[540px] min-h-[120px] overflow-auto bg-surface-variant">
        <div className="m-4 rounded-md border border-border bg-white px-[28px] py-[24px] text-[13px] leading-[1.85] sm:px-[44px] sm:py-[32px]">
          <h3 className="mb-2 text-[22px] font-bold leading-[1.3] tracking-[-0.02em] text-on-surface">
            {output.summary?.split("—")[0]?.trim() ?? output.stage}
          </h3>
          <div className="mb-[18px] border-b border-border pb-[14px] text-[12px] text-on-surface-variant">
            v{output.version ?? 1}
            {output.created_at ? ` · ${fmtDateTime(output.created_at)}` : ""} ·{" "}
            {fmt.toUpperCase()} プレビュー
          </div>
          <p className="text-on-surface">{output.summary ?? "サマリー未生成の成果物です。"}</p>
        </div>
      </div>
    </div>
  );
}

export function PhaseTabs({
  projectId,
  outputs,
  threads,
  tasks,
  decisions,
  unresolved,
}: {
  readonly projectId: string;
  readonly outputs: readonly PhaseOutput[];
  readonly threads: readonly PhaseThread[];
  readonly tasks: readonly PhaseTask[];
  readonly decisions: readonly PhaseDecision[];
  readonly unresolved: readonly PhaseDecision[];
}) {
  const [active, setActive] = useState<TabKey>("decisions");
  const [showAllDecisions, setShowAllDecisions] = useState(false);
  const counts: Record<TabKey, number> = {
    decisions: decisions.length,
    outputs: outputs.length,
    discussion: threads.length,
    unresolved: unresolved.length,
    tasks: tasks.length,
  };
  const visibleDecisions = showAllDecisions
    ? decisions
    : decisions.slice(0, DECISIONS_PREVIEW_COUNT);

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

      {/* 確定事項 */}
      <div
        role="tabpanel"
        id="panel-decisions"
        aria-labelledby="tab-decisions"
        hidden={active !== "decisions"}
      >
        {decisions.length === 0 ? (
          <EmptyState>
            この工程の確定事項はまだありません。AI 社員との議論で決まった事項がここに積み上がります。
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-2">
            {visibleDecisions.map((d) => (
              <DecisionItem key={d.id} decision={d} />
            ))}
            {decisions.length > DECISIONS_PREVIEW_COUNT && !showAllDecisions ? (
              <div className="py-4 text-center">
                <button
                  type="button"
                  onClick={() => setShowAllDecisions(true)}
                  className="text-[13px] font-semibold text-primary hover:underline"
                >
                  他 {decisions.length - DECISIONS_PREVIEW_COUNT} 件を見る →
                </button>
              </div>
            ) : null}
          </div>
        )}
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
          <div className="flex flex-col gap-4">
            <OutputPreviewCard output={outputs[0]!} projectId={projectId} />
            {outputs.length > 1 ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {outputs.slice(1).map((o) => (
                  <div
                    key={o.id}
                    className="rounded-md border border-border bg-white px-[14px] py-3"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <FileText
                        className="h-[13px] w-[13px] shrink-0 text-on-surface-variant"
                        aria-hidden="true"
                      />
                      <strong className="truncate text-[13px] font-semibold text-on-surface">
                        {o.summary ?? o.stage ?? "成果物"}
                      </strong>
                    </div>
                    <div className="text-[12px] text-on-surface-variant">
                      v{o.version ?? 1}
                      {o.created_at ? ` · ${fmtDateTime(o.created_at)}` : ""}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <Link
                        href={`/outputs?project=${projectId}&output=${o.id}`}
                        className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline"
                      >
                        <Eye className="h-3 w-3" aria-hidden="true" />
                        表示
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
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
                <EmployeeAvatar name={th.employeeName} color={th.employeeColor} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-on-surface">
                    {th.title ?? "無題スレッド"}
                  </span>
                  <span className="block text-[11.5px] text-on-surface-variant">
                    {th.employeeName ?? "AI社員"}
                    {typeof th.messageCount === "number"
                      ? ` · ${th.messageCount} 件のメッセージ`
                      : ""}
                    {th.updated_at ? ` · ${relTime(th.updated_at)}` : ""}
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

      {/* 未確認 */}
      <div
        role="tabpanel"
        id="panel-unresolved"
        aria-labelledby="tab-unresolved"
        hidden={active !== "unresolved"}
      >
        {unresolved.length === 0 ? (
          <EmptyState>未確認事項はありません。</EmptyState>
        ) : (
          <div className="flex flex-col">
            {unresolved.map((d) => (
              <UnresolvedItem key={d.id} decision={d} />
            ))}
          </div>
        )}
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
  /** 議論相手候補 (モックの「スティーブと議論」「ピーターに依頼」) */
  readonly employees?: readonly PhaseEmployee[];
  readonly threadCount: number;
  readonly taskCount: number;
  readonly knowledgeCount?: number;
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
  employees = [],
  threadCount,
  taskCount,
  knowledgeCount,
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
        {employees.slice(0, 2).map((emp, i) => (
          <Link key={emp.id} href={`/chat?project=${projectId}`} className={quickBtn}>
            <MessageSquare className="h-[14px] w-[14px]" aria-hidden="true" />
            {emp.name}
            {i === 0 ? "と議論" : "に依頼"}
          </Link>
        ))}
        {employees.length === 0 ? (
          <Link href={`/chat?project=${projectId}`} className={quickBtn}>
            <MessageSquare className="h-[14px] w-[14px]" aria-hidden="true" />
            AI社員と議論する
          </Link>
        ) : null}
        {onComplete && currentPhase?.status === "in_progress" ? (
          <button
            type="button"
            onClick={onComplete}
            disabled={completing}
            className={cn(quickBtn, "disabled:opacity-50")}
          >
            <Check className="h-[14px] w-[14px]" aria-hidden="true" />
            {completing
              ? "更新中…"
              : hasNext
                ? "この工程を完了して次へ"
                : "この工程を完了"}
          </button>
        ) : null}
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
        {typeof knowledgeCount === "number" ? (
          <div className={linkRow}>
            <Link
              href={`/knowledge?project=${projectId}`}
              className="flex flex-1 items-center gap-[6px] text-on-surface hover:text-primary"
            >
              <FileText className="h-[14px] w-[14px]" aria-hidden="true" />
              参照ナレッジ
            </Link>
            <span className="text-[11.5px] tabular-nums text-on-surface-variant">
              {knowledgeCount} 件
            </span>
          </div>
        ) : null}
        <div className={linkRow}>
          <Link
            href={`/workflow/phases?project=${projectId}`}
            className="flex flex-1 items-center gap-[6px] text-on-surface hover:text-primary"
          >
            <GitBranch className="h-[14px] w-[14px]" aria-hidden="true" />
            フェーズ管理
          </Link>
          <span className="text-[11.5px] tabular-nums text-on-surface-variant">
            {currentPhase ? `Stage ${currentPhase.index + 1}` : "—"}
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
