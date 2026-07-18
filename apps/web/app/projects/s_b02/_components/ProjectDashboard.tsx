/**
 * S-B02 プロジェクトダッシュボード presentational — T-UC-04
 *
 * モック 06_mockups/project/S-B02-dashboard.html 準拠:
 *   - ヘッダー: PROJECT DASHBOARD kicker + h1 + プロジェクト名/種別/現工程のサブタイトル
 *   - KPI 4 枚 (全体進捗率 / 未承認 INBOX / 今日の活動 / 確定事項)
 *   - 工程の流れ (9 工程ステッパー + 「工程画面で確定事項・成果物を見る」リンク)
 *   - 左: 最新の活動タイムライン (確定事項/成果物/スレッド/工程完了の実タイムスタンプ合成)
 *   - 右: 承認リクエスト (実 approval-inbox・承認/差戻ボタン) / 最新成果物 / AI 社員アクティビティ
 *
 * モックの「未解決コメント」KPI はプロジェクト横断コメント API が無いため「確定事項」に
 * 置換 (gap-tracker GAP-005)。「AI 提案」カードは実体である承認インボックスに配線。
 * KPI ラベルは中立色・数値のみ tone 色 (tinted 面での AA 4.5 割れ回避・axe 実測に基づく)。
 */

"use client";

import * as React from "react";
import Link from "next/link";
import {
  Check,
  ExternalLink,
  FileText,
  GitBranch,
  Inbox,
  MessageSquare,
  Zap,
} from "lucide-react";

import { Skeleton } from "../../../../components/Skeleton";
import { cn } from "../../../../lib/cn";
import { fmtTime, relTime } from "../../../../lib/format";

/* ------------------------------------------------------------------ */

export interface DashboardKpi {
  readonly id: string;
  readonly label: string;
  readonly value: number | string;
  readonly sub?: string;
  readonly tone?: "info" | "success" | "error";
}

export interface StageItem {
  readonly id: string;
  readonly label: string;
  readonly status: "done" | "in_progress" | "pending" | "blocked";
}

export interface ActivityItem {
  readonly id: string;
  readonly kind: "decision" | "output" | "thread" | "phase";
  readonly text: string;
  readonly actorName?: string;
  readonly actorColor?: string;
  readonly at?: string;
  readonly href?: string;
}

export interface ApprovalItem {
  readonly id: string;
  readonly title: string;
  readonly note?: string;
}

export interface OutputItem {
  readonly id: string;
  readonly title: string;
  readonly format: string;
  readonly href: string;
}

export interface EmployeeActivityItem {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly lastActiveAt?: string;
}

export interface ProjectDashboardProps {
  readonly projectName: string;
  /** サブタイトル補足 (種別 · 現工程 等) */
  readonly projectMeta?: string;
  readonly kpis: readonly DashboardKpi[];
  readonly stages?: readonly StageItem[];
  readonly activities?: readonly ActivityItem[];
  readonly approvals?: readonly ApprovalItem[];
  readonly outputs?: readonly OutputItem[];
  readonly employees?: readonly EmployeeActivityItem[];
  readonly projectId?: string;
  readonly loading?: boolean;
  readonly onDecideApproval?: (
    id: string,
    decision: "approve" | "reject",
  ) => void;
  readonly decidingApprovalId?: string | null;
}

const TONE_TEXT: Record<NonNullable<DashboardKpi["tone"]>, string> = {
  info: "text-on-surface",
  success: "text-tertiary-container-fg",
  error: "text-error",
};

export function ProjectDashboard({
  projectName,
  projectMeta,
  kpis,
  stages = [],
  activities = [],
  approvals = [],
  outputs = [],
  employees = [],
  projectId,
  loading = false,
  onDecideApproval,
  decidingApprovalId = null,
}: ProjectDashboardProps) {
  const q = projectId ? `?project=${projectId}` : "";

  return (
    <div className="flex flex-col gap-6">
      {/* ヘッダー (モック: kicker + h1 + サブタイトル) */}
      <header className="flex flex-col gap-1">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
          Project Dashboard
        </span>
        <h1 className="text-[26px] font-bold leading-tight tracking-[-0.02em] text-on-surface">
          プロジェクトダッシュボード
        </h1>
        <p className="text-[13px] text-on-surface-variant">
          <span className="font-semibold text-on-surface">{projectName}</span>
          {projectMeta ? ` · ${projectMeta}` : ""}
        </p>
      </header>

      {/* KPI 4 枚 (モック .kpi-card) */}
      <section aria-label="KPI 一覧" className="grid grid-cols-2 gap-md lg:grid-cols-4">
        {loading && kpis.length === 0
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height={104} className="w-full rounded-lg" />
            ))
          : kpis.map((k) => (
              <article
                key={k.id}
                className="flex flex-col gap-1 rounded-lg border border-border bg-white px-[18px] py-4"
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
                {k.sub ? (
                  <span className="mt-1 text-[11px] font-semibold text-tertiary-container-fg">
                    {k.sub}
                  </span>
                ) : null}
              </article>
            ))}
      </section>

      {/* 工程の流れ (S-F01 と同じ canonical 表現 + 工程画面リンク) */}
      {stages.length > 0 ? (
        <section aria-label="工程の流れ" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold text-on-surface">
              工程の流れ（{stages.length} 工程）
            </h2>
            <Link
              href={`/workflow${q}`}
              className="inline-flex items-center gap-1 rounded-md border border-primary px-3 py-[6px] text-[12px] font-semibold text-primary transition-colors hover:bg-primary-container"
            >
              <ExternalLink size={12} aria-hidden="true" />
              工程画面で確定事項・成果物を見る
            </Link>
          </div>
          <div className="overflow-x-auto rounded-lg border border-border bg-white px-4 py-5">
            <ol className="flex min-w-[720px]" aria-label="工程一覧">
              {stages.map((st, i) => (
                <li
                  key={st.id}
                  className="relative flex min-w-[80px] flex-1 flex-col items-center text-center"
                >
                  {i < stages.length - 1 ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute left-[calc(50%+17px)] right-[calc(-50%+17px)] top-[16px] h-0.5",
                        st.status === "done" ? "bg-tertiary" : "bg-border",
                      )}
                    />
                  ) : null}
                  <span
                    className={cn(
                      "relative z-[1] flex h-[34px] w-[34px] items-center justify-center rounded-full border-2 text-[12.5px] font-bold",
                      st.status === "done" &&
                        "border-tertiary bg-tertiary text-on-tertiary",
                      st.status === "in_progress" &&
                        "border-primary bg-primary text-on-primary shadow-[0_0_0_3px_#DBEAFE]",
                      st.status === "pending" &&
                        "border-border bg-surface-variant text-on-surface-variant",
                      st.status === "blocked" && "border-error bg-error text-on-error",
                    )}
                  >
                    {st.status === "done" ? (
                      <Check size={13} strokeWidth={3} aria-hidden="true" />
                    ) : (
                      i + 1
                    )}
                  </span>
                  <span
                    className={cn(
                      "mt-2 text-[11.5px] font-bold leading-tight",
                      st.status === "in_progress" ? "text-primary" : "text-on-surface",
                    )}
                  >
                    {st.label}
                  </span>
                  <span className="mt-[2px] text-[10px] text-on-surface-variant">
                    {st.status === "done"
                      ? "完了"
                      : st.status === "in_progress"
                        ? "進行中"
                        : st.status === "blocked"
                          ? "ブロック"
                          : "待機"}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </section>
      ) : null}

      {/* 本文 2 カラム (モック: 左タイムライン / 右レール) */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* 左: 最新の活動 */}
        <section
          aria-label="最新の活動"
          className="rounded-lg border border-border bg-white px-[22px] py-5"
        >
          <h2 className="mb-3 text-[15px] font-bold text-on-surface">最新の活動</h2>
          {activities.length === 0 ? (
            <p className="py-4 text-[13px] leading-[1.7] text-on-surface-variant">
              まだ活動がありません。チャットで AI 社員に依頼すると、確定事項や成果物が
              ここに積み上がります。
            </p>
          ) : (
            <ol className="flex flex-col">
              {activities.map((a) => (
                <li
                  key={`${a.kind}-${a.id}`}
                  className="flex items-start gap-3 border-b border-border py-3 last:border-b-0"
                >
                  <span className="w-[42px] shrink-0 pt-[2px] text-[11px] tabular-nums text-on-surface-variant">
                    {fmtTime(a.at)}
                  </span>
                  <span
                    aria-hidden="true"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white"
                    style={{ backgroundColor: a.actorColor ?? "#94A3B8" }}
                  >
                    {(a.actorName ?? "系").charAt(0)}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px] leading-[1.6] text-on-surface">
                    {a.actorName ? (
                      <strong className="font-semibold">{a.actorName}</strong>
                    ) : null}
                    {a.actorName ? " " : ""}
                    {a.href ? (
                      <Link href={a.href} className="hover:text-primary hover:underline">
                        {a.text}
                      </Link>
                    ) : (
                      a.text
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* 右レール */}
        <aside className="flex flex-col gap-4" aria-label="サイド情報">
          {/* 承認リクエスト (実 approval-inbox。モックの「AI 提案」スロットの実体) */}
          {approvals.length > 0 ? (
            <div className="rounded-lg border border-primary bg-primary-container/60 px-[18px] py-4">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-on-primary-container">
                <Zap size={11} aria-hidden="true" />
                承認リクエスト
              </div>
              {approvals.slice(0, 1).map((ap) => (
                <div key={ap.id}>
                  <div className="text-[13.5px] font-bold leading-[1.5] text-on-surface">
                    {ap.title}
                  </div>
                  {ap.note ? (
                    <p className="mt-1 text-[12px] leading-[1.6] text-on-surface-variant">
                      {ap.note}
                    </p>
                  ) : null}
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={decidingApprovalId === ap.id}
                      onClick={() => onDecideApproval?.(ap.id, "approve")}
                      className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-[6px] text-[12px] font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      <Check size={12} aria-hidden="true" />
                      {decidingApprovalId === ap.id ? "処理中…" : "承認"}
                    </button>
                    <button
                      type="button"
                      disabled={decidingApprovalId === ap.id}
                      onClick={() => onDecideApproval?.(ap.id, "reject")}
                      className="inline-flex items-center rounded-md border border-border bg-white px-3 py-[6px] text-[12px] font-semibold text-on-surface transition-colors hover:border-primary disabled:opacity-50"
                    >
                      差戻
                    </button>
                    <Link
                      href="/approvals"
                      className="ml-auto inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary hover:underline"
                    >
                      <Inbox size={11} aria-hidden="true" />
                      Inbox で確認
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {/* 最新成果物 */}
          <div className="rounded-lg border border-border bg-white px-[18px] py-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
              最新成果物
            </div>
            {outputs.length === 0 ? (
              <p className="text-[12px] leading-[1.6] text-on-surface-variant">
                成果物はまだありません。
              </p>
            ) : (
              outputs.slice(0, 4).map((o) => (
                <div
                  key={o.id}
                  className="flex items-center gap-2 border-b border-border py-[7px] text-[12.5px] last:border-b-0"
                >
                  <FileText
                    size={13}
                    aria-hidden="true"
                    className="shrink-0 text-on-surface-variant"
                  />
                  <Link
                    href={o.href}
                    className="min-w-0 flex-1 truncate font-medium text-primary hover:underline"
                  >
                    {o.title}
                  </Link>
                  <span className="shrink-0 text-[10.5px] font-bold uppercase text-on-surface-variant">
                    {o.format}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* AI 社員アクティビティ */}
          <div className="rounded-lg border border-border bg-white px-[18px] py-4">
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-on-surface-variant">
              AI 社員アクティビティ
            </div>
            {employees.length === 0 ? (
              <p className="text-[12px] leading-[1.6] text-on-surface-variant">
                このプロジェクトで活動中の AI 社員はまだいません。
              </p>
            ) : (
              employees.slice(0, 5).map((e) => (
                <div
                  key={e.id}
                  className="flex items-center gap-2 border-b border-border py-[7px] last:border-b-0"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10.5px] font-bold text-white"
                    style={{ backgroundColor: e.color }}
                  >
                    {e.name.charAt(0)}
                  </span>
                  <span className="flex-1 text-[12.5px] font-medium text-on-surface">
                    {e.name}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-variant px-2 py-[2px] text-[10.5px] font-semibold text-on-surface-variant">
                    <span
                      aria-hidden="true"
                      className="h-[5px] w-[5px] rounded-full bg-tertiary"
                    />
                    {e.lastActiveAt ? relTime(e.lastActiveAt) : "待機"}
                  </span>
                </div>
              ))
            )}
            <Link
              href={`/chat${q}`}
              className="mt-2 inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary hover:underline"
            >
              <MessageSquare size={11} aria-hidden="true" />
              チャットで依頼する
            </Link>
          </div>

          <Link
            href={`/workflow/phases${q}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-white px-[18px] py-3 text-[12.5px] font-semibold text-on-surface transition-colors hover:border-primary hover:text-primary"
          >
            <GitBranch size={13} aria-hidden="true" />
            フェーズ管理を開く
          </Link>
        </aside>
      </div>
    </div>
  );
}
