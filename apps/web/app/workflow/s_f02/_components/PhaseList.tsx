/**
 * S-F02 フェーズ管理 — T-UC-11 / GAP-022
 *
 * モック (06_mockups/workflow/S-F02-phases.html) 忠実:
 * フェーズタイムライン（フェーズカード + 進捗番号 + 状態 pill + 状態変更 select +
 * phase 別タスク集計行）を左 2fr、右 1fr に F-IMP01 影響範囲解析 / 統計 /
 * 運用ルールを配置。GAP-022 で全要素を実 API 配線:
 *   - AI 提案フェーズ (.phase-card.proposed): ジャービスへの提案依頼 (明示操作) →
 *     pending カード (承認 / 却下 / 提案理由を見る)
 *   - F-IMP01: タスク + 移動先を選んで実解析 → 影響ノード表示 → 承認して移動
 *     (完了済影響はリファクタタスク自動起票 — F-CUC02)
 *   - 統計: 提案中 / F-IMP01 実行回数（本日）/ 依存整合性チェック (すべて実データ)
 */

"use client";

import * as React from "react";
import { useState } from "react";

export type PhaseStatus = "pending" | "in_progress" | "done" | "blocked";

export interface PhaseRow {
  readonly id: string;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly order: number;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
  readonly description?: string | null;
  /** GAP-004: 担当 AI 社員 ID 群 (phases.assigned_employee_ids)。 */
  readonly assignedEmployeeIds?: readonly string[];
}

/** 割当ピッカー用の WS 社員 (GAP-004)。 */
export interface AssignableEmployee {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
}

/** phase 別タスク集計 (GAP-022 — 実 /workflow/phase-task-stats)。 */
export interface PhaseTaskStats {
  readonly total: number;
  readonly done: number;
  readonly awaiting: number;
  readonly avgScore?: number | null;
}

/** COO AI (ジャービス) のフェーズ提案 (GAP-022 — phase_proposals pending)。 */
export interface PhaseProposalItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly reason: string;
  readonly proposedOrder: number;
  /** YYYY-MM-DD HH:mm 済み表示文字列 */
  readonly createdAt: string;
}

/** F-IMP01 の解析対象候補タスク。 */
export interface ImpactTaskOption {
  readonly id: string;
  readonly title: string;
}

/** F-IMP01 解析結果 (実 /workflow/impact-analysis)。 */
export interface ImpactResult {
  readonly id: string;
  readonly taskTitle: string;
  readonly targetPhaseName: string;
  readonly affected: readonly {
    readonly id: string;
    readonly title: string;
    readonly lifecycleStage: string;
  }[];
  readonly doneCount: number;
  readonly applied: boolean;
}

/** 統計行の実データ (GAP-022)。 */
export interface WorkflowStats {
  readonly pendingProposals: number;
  readonly impactTodayCount: number;
  readonly consistencyOk: boolean;
  readonly danglingCount: number;
}

/** ISO → YYYY-MM-DD。null は返さない。 */
function dateLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 期間表示 (開始〜完了 / 開始〜 / 未着手)。 */
function periodLabel(row: PhaseRow): string {
  const s = dateLabel(row.startedAt);
  const e = dateLabel(row.completedAt);
  if (s && e) return `${s} 〜 ${e}`;
  if (s) return `${s} 〜`;
  return "未着手";
}

export interface PhaseListProps {
  readonly rows: readonly PhaseRow[];
  /** 状態遷移。controlled（コンテナが API 配線して rows を更新する）。 */
  readonly onTransition?: (id: string, status: PhaseStatus) => void;
  /**
   * GAP-004: 担当割当。employees と onAssign の両方があるときだけ割当 UI を出す
   * (Rule 10)。onAssign は新しい ID 配列で丸ごと置換。
   */
  readonly employees?: readonly AssignableEmployee[];
  readonly onAssign?: (id: string, employeeIds: readonly string[]) => void;
  /** GAP-022: phase 別タスク集計 (phase id → 実集計)。 */
  readonly taskStats?: Readonly<Record<string, PhaseTaskStats>>;
  /** GAP-022: pending のフェーズ提案 (タイムライン末尾に proposed カード)。 */
  readonly proposal?: PhaseProposalItem | null;
  /** ジャービスに次フェーズの提案を依頼 (明示操作)。 */
  readonly onPropose?: () => void;
  readonly proposing?: boolean;
  readonly onApproveProposal?: (id: string) => void;
  readonly onRejectProposal?: (id: string) => void;
  readonly proposalResolving?: boolean;
  /** GAP-022: F-IMP01 影響範囲解析。 */
  readonly impactTasks?: readonly ImpactTaskOption[];
  readonly onAnalyzeImpact?: (taskId: string, targetPhaseId: string) => void;
  readonly analyzing?: boolean;
  readonly impactResult?: ImpactResult | null;
  readonly onApplyImpact?: (analysisId: string) => void;
  readonly applyingImpact?: boolean;
  /** GAP-022: 統計 (提案中 / F-IMP01 実行回数 / 整合性)。 */
  readonly stats?: WorkflowStats;
  readonly actionNotice?: string;
  readonly actionError?: string;
}

const STATUS_LABEL: Record<PhaseStatus, string> = {
  pending: "未着手",
  in_progress: "進行中",
  done: "完了",
  blocked: "ブロック",
};

/** カード面の色・左ボーダー（mock .phase-card / .done / .current）。 */
const CARD_VARIANT: Record<PhaseStatus, string> = {
  done: "bg-tertiary-container text-tertiary-container-fg border-border",
  in_progress: "bg-white text-on-surface border-border border-l-[3px] border-l-primary",
  pending: "bg-white text-on-surface border-border",
  blocked: "bg-white text-on-surface border-border border-l-[3px] border-l-error",
};

/** 進捗番号バッジの色（mock .phase-num）。 */
const NUM_VARIANT: Record<PhaseStatus, string> = {
  done: "bg-tertiary text-on-tertiary",
  in_progress: "bg-primary text-on-primary",
  pending: "bg-surface-variant text-on-surface-variant",
  blocked: "bg-error text-on-error",
};

/** 状態 pill の面色 + ドット色（mock .pill-*）。 */
const PILL_VARIANT: Record<PhaseStatus, { readonly pill: string; readonly dot: string }> = {
  pending: {
    pill: "bg-surface-variant text-on-surface-variant",
    dot: "bg-on-surface-variant",
  },
  in_progress: {
    pill: "bg-tertiary-container text-tertiary-container-fg",
    dot: "bg-tertiary",
  },
  done: {
    pill: "bg-tertiary-container text-tertiary-container-fg",
    dot: "bg-tertiary",
  },
  blocked: {
    pill: "bg-[#FEE2E2] text-[#991B1B]",
    dot: "bg-error",
  },
};

interface PhaseCardProps {
  readonly row: PhaseRow;
  readonly onTransition?: (id: string, status: PhaseStatus) => void;
  readonly employees?: readonly AssignableEmployee[];
  readonly onAssign?: (id: string, employeeIds: readonly string[]) => void;
  /** GAP-022: このフェーズの実タスク集計 (無ければ行を出さない)。 */
  readonly stats?: PhaseTaskStats;
}

function PhaseCard({ row, onTransition, employees, onAssign, stats }: PhaseCardProps) {
  const pill = PILL_VARIANT[row.status];
  const metaClass =
    row.status === "done"
      ? "text-sm opacity-80"
      : "text-sm text-on-surface-variant";

  return (
    <li
      className={`rounded-lg border px-[22px] py-[18px] ${CARD_VARIANT[row.status]}`}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full text-[12px] font-bold ${NUM_VARIANT[row.status]}`}
        >
          {row.status === "done" ? "✓" : row.order}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-bold">{row.name}</div>
          <div className={metaClass}>
            第 {row.order} 段階 · {periodLabel(row)}
            {row.description ? ` · ${row.description}` : ""}
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${pill.pill}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
          {STATUS_LABEL[row.status]}
        </span>
      </div>

      {/* GAP-022: phase-tasks 行 (モック準拠 — 実 /workflow/phase-task-stats) */}
      {stats && stats.total > 0 ? (
        <div className="mt-2 flex flex-wrap gap-4 border-t border-border/60 pt-2 text-[12.5px]">
          {row.status === "done" && stats.done === stats.total ? (
            <span>
              <strong className="font-bold">{stats.done}</strong> タスク完了
            </span>
          ) : (
            <span>
              <strong className="font-bold">{stats.done}</strong> / {stats.total}{" "}
              タスク完了
            </span>
          )}
          {stats.awaiting > 0 ? (
            <span>
              <strong className="font-bold">{stats.awaiting}</strong> 承認待ち
            </span>
          ) : null}
          {stats.avgScore != null ? (
            <span className="text-[#0F766E]">
              スコア平均 {stats.avgScore.toFixed(2)}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-2 border-t border-border pt-2">
        <span className="text-[11px] font-medium opacity-80">状態を変更</span>
        <select
          value={row.status}
          onChange={(e) => onTransition?.(row.id, e.target.value as PhaseStatus)}
          aria-label={`${row.name} の状態`}
          className="h-8 rounded-md border border-border bg-white px-2 text-label-md text-on-surface"
        >
          {(Object.keys(STATUS_LABEL) as PhaseStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        {/* GAP-004: 担当 AI 社員の割当 (チップ + 追加 select) */}
        {employees && onAssign ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            <span className="text-[11px] font-medium opacity-80">担当</span>
            {(row.assignedEmployeeIds ?? []).map((eid) => {
              const emp = employees.find((e) => e.id === eid);
              if (!emp) return null;
              return (
                <span
                  key={eid}
                  className="inline-flex items-center gap-1 rounded-full bg-surface-variant py-0.5 pl-1 pr-1.5 text-[11px] font-semibold text-on-surface"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white"
                    style={{ backgroundColor: emp.color ?? "#2563EB" }}
                  >
                    {emp.name.charAt(0)}
                  </span>
                  {emp.name}
                  <button
                    type="button"
                    aria-label={`${row.name} の担当から ${emp.name} を外す`}
                    onClick={() =>
                      onAssign(
                        row.id,
                        (row.assignedEmployeeIds ?? []).filter((x) => x !== eid),
                      )
                    }
                    className="ml-0.5 rounded-full px-0.5 text-on-surface-variant hover:text-error"
                  >
                    ×
                  </button>
                </span>
              );
            })}
            <select
              value=""
              aria-label={`${row.name} に担当を追加`}
              onChange={(e) => {
                if (!e.target.value) return;
                onAssign(row.id, [
                  ...(row.assignedEmployeeIds ?? []),
                  e.target.value,
                ]);
                e.target.value = "";
              }}
              className="h-7 rounded-md border border-border bg-white px-1.5 text-[11px] text-on-surface-variant"
            >
              <option value="">+ 追加</option>
              {employees
                .filter((e) => !(row.assignedEmployeeIds ?? []).includes(e.id))
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
      </div>
    </li>
  );
}

interface StatRowProps {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly valueClass?: string;
}

function StatRow({ label, value, valueClass }: StatRowProps) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-sm text-on-surface-variant">{label}</dt>
      <dd className={`font-bold tabular-nums ${valueClass ?? "text-on-surface"}`}>
        {value}
      </dd>
    </div>
  );
}

export function PhaseList({
  rows,
  onTransition,
  employees,
  onAssign,
  taskStats,
  proposal,
  onPropose,
  proposing = false,
  onApproveProposal,
  onRejectProposal,
  proposalResolving = false,
  impactTasks,
  onAnalyzeImpact,
  analyzing = false,
  impactResult,
  onApplyImpact,
  applyingImpact = false,
  stats,
  actionNotice,
  actionError,
}: PhaseListProps) {
  const total = rows.length;
  const done = rows.filter((r) => r.status === "done").length;
  const inProgress = rows.filter((r) => r.status === "in_progress").length;
  const pending = rows.filter((r) => r.status === "pending").length;
  const blocked = rows.filter((r) => r.status === "blocked").length;
  const [reasonOpen, setReasonOpen] = useState(false);
  const [impactTaskId, setImpactTaskId] = useState("");
  const [impactPhaseId, setImpactPhaseId] = useState("");

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[2fr_1fr]">
      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-on-surface">
            フェーズタイムライン
          </h2>
          {onPropose ? (
            proposing ? (
              <span role="status" className="text-[12px] text-on-surface-variant">
                ジャービスが次フェーズを検討中…
              </span>
            ) : (
              <button
                type="button"
                onClick={onPropose}
                disabled={proposal != null}
                title={
                  proposal != null
                    ? "承認待ちの提案があるため新しい提案は依頼できません"
                    : undefined
                }
                className="rounded-md border border-primary px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary-container disabled:opacity-50"
              >
                ジャービスに次フェーズを提案してもらう
              </button>
            )
          ) : null}
        </div>

        {actionError ? (
          <p
            role="alert"
            className="mb-3 rounded-md bg-error/10 px-3 py-2 text-[12.5px] text-error"
          >
            {actionError}
          </p>
        ) : actionNotice ? (
          <p
            role="status"
            className="mb-3 rounded-md bg-tertiary-container px-3 py-2 text-[12.5px] text-tertiary-container-fg"
          >
            {actionNotice}
          </p>
        ) : null}

        {total === 0 && !proposal ? (
          <div className="rounded-lg border border-border bg-white py-12 text-center text-on-surface-variant">
            フェーズがありません
          </div>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {rows.map((r) => (
              <PhaseCard
                key={r.id}
                row={r}
                onTransition={onTransition}
                employees={employees}
                onAssign={onAssign}
                stats={taskStats?.[r.id]}
              />
            ))}

            {/* GAP-022: AI 提案フェーズ (.phase-card.proposed 準拠) */}
            {proposal ? (
              <li className="rounded-lg border border-secondary bg-secondary-container px-[22px] py-[18px] text-secondary-container-fg">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full bg-secondary text-[14px] font-bold text-on-secondary"
                  >
                    ✦
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold">
                      {proposal.name}（AI提案）
                    </div>
                    <div className="text-sm opacity-85">
                      第 {proposal.proposedOrder} 段階
                      {proposal.description ? ` · ${proposal.description}` : ""}
                    </div>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-2.5 py-1 text-[11px] font-semibold text-on-surface">
                    <span className="h-1.5 w-1.5 rounded-full bg-secondary" />
                    承認待ち
                  </span>
                </div>
                <div className="mt-2 border-t border-black/10 pt-2 text-[12.5px]">
                  ジャービスが提案 · {proposal.createdAt}
                </div>
                {reasonOpen ? (
                  <p className="mt-2 rounded-md bg-white/60 px-3 py-2 text-[12.5px] leading-relaxed">
                    {proposal.reason}
                  </p>
                ) : null}
                {onApproveProposal && onRejectProposal ? (
                  <div className="mt-4 flex items-center gap-2">
                    {proposalResolving ? (
                      <span role="status" className="text-[12px]">
                        処理中…
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onApproveProposal(proposal.id)}
                          className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-on-primary hover:bg-[#1E54D8]"
                        >
                          承認
                        </button>
                        <button
                          type="button"
                          onClick={() => onRejectProposal(proposal.id)}
                          className="rounded-md border border-border bg-white px-3 py-1.5 text-[12px] font-semibold text-on-surface hover:bg-surface-variant"
                        >
                          却下
                        </button>
                        <button
                          type="button"
                          onClick={() => setReasonOpen((v) => !v)}
                          aria-expanded={reasonOpen}
                          className="rounded-md px-3 py-1.5 text-[12px] font-semibold text-on-surface hover:bg-white/60"
                        >
                          提案理由を見る
                        </button>
                      </>
                    )}
                  </div>
                ) : null}
              </li>
            ) : null}
          </ol>
        )}
      </section>

      <aside className="flex flex-col gap-4">
        {/* GAP-022: F-IMP01 影響範囲解析 (実解析 — モックの結果カードを対話化) */}
        {impactTasks && impactTasks.length > 0 && onAnalyzeImpact ? (
          <div className="rounded-lg bg-primary-container p-5 text-on-primary-container">
            {/* a11y: opacity-70 だと on-primary-container が地色に対し 4.5:1 未満 */}
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] opacity-90">
              F-IMP01 · 影響範囲解析
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!impactTaskId || !impactPhaseId || analyzing) return;
                onAnalyzeImpact(impactTaskId, impactPhaseId);
              }}
              className="flex flex-col gap-2"
            >
              <label className="block">
                <span className="text-[11.5px] font-semibold">対象タスク</span>
                <select
                  value={impactTaskId}
                  onChange={(e) => setImpactTaskId(e.target.value)}
                  aria-label="影響解析の対象タスク"
                  className="mt-1 w-full rounded-md border border-black/10 bg-white px-2 py-1.5 text-[12.5px] text-on-surface"
                >
                  <option value="">選択してください</option>
                  {impactTasks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11.5px] font-semibold">移動先フェーズ</span>
                <select
                  value={impactPhaseId}
                  onChange={(e) => setImpactPhaseId(e.target.value)}
                  aria-label="移動先フェーズ"
                  className="mt-1 w-full rounded-md border border-black/10 bg-white px-2 py-1.5 text-[12.5px] text-on-surface"
                >
                  <option value="">選択してください</option>
                  {rows.map((p) => (
                    <option key={p.id} value={p.id}>
                      第 {p.order} 段階 · {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                disabled={!impactTaskId || !impactPhaseId || analyzing}
                className="mt-1 self-start rounded-md bg-on-primary-container px-3 py-1.5 text-[12px] font-semibold text-primary-container disabled:opacity-50"
              >
                {analyzing ? "解析中…" : "影響を解析"}
              </button>
            </form>

            {impactResult ? (
              <div className="mt-3 border-t border-black/10 pt-3">
                <h3 className="mb-1 text-[13px] font-bold">
                  タスク「{impactResult.taskTitle}」を{" "}
                  {impactResult.targetPhaseName} へ移動した場合
                </h3>
                <p className="mb-2 text-sm">
                  {impactResult.affected.length} タスクへの影響を検出（実装済み{" "}
                  {impactResult.doneCount} / その他{" "}
                  {impactResult.affected.length - impactResult.doneCount}）
                </p>
                {impactResult.affected.length > 0 ? (
                  <div className="mb-2 flex flex-wrap items-center gap-1">
                    <span className="inline-flex items-center rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-on-surface">
                      {impactResult.taskTitle}
                    </span>
                    <span aria-hidden="true" className="opacity-70">
                      →
                    </span>
                    {impactResult.affected.map((a) => (
                      <span
                        key={a.id}
                        className="inline-flex items-center rounded-full bg-secondary-container px-3 py-1 text-[12px] text-secondary-container-fg"
                      >
                        {a.title}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="mb-2 text-sm opacity-85">
                    依存しているタスクはありません。
                  </p>
                )}
                {impactResult.doneCount > 0 ? (
                  <p className="mb-2 text-sm opacity-90">
                    完了済 {impactResult.doneCount} タスクは{" "}
                    <strong className="font-bold">
                      リファクタタスクとして自動起票
                    </strong>{" "}
                    されます（F-CUC02）。
                  </p>
                ) : null}
                {onApplyImpact && !impactResult.applied ? (
                  <button
                    type="button"
                    onClick={() => onApplyImpact(impactResult.id)}
                    disabled={applyingImpact}
                    className="rounded-md bg-on-primary-container px-3 py-1.5 text-[12px] font-semibold text-primary-container disabled:opacity-50"
                  >
                    {applyingImpact ? "適用中…" : "承認して移動"}
                  </button>
                ) : impactResult.applied ? (
                  <p className="text-[12px] font-semibold">適用済み</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="rounded-lg border border-border bg-white p-5">
          <h3 className="mb-3 text-sm font-bold text-on-surface">統計</h3>
          <dl className="flex flex-col gap-3">
            <StatRow label="確定フェーズ数" value={`${done} / ${total}`} />
            <StatRow
              label="進行中"
              value={inProgress}
              valueClass="text-[#0F766E]"
            />
            <StatRow label="未着手" value={pending} />
            <StatRow
              label="ブロック"
              value={blocked}
              valueClass={blocked > 0 ? "text-error" : "text-on-surface"}
            />
            {stats ? (
              <>
                <StatRow
                  label="提案中"
                  value={stats.pendingProposals}
                  valueClass={
                    stats.pendingProposals > 0 ? "text-primary" : "text-on-surface"
                  }
                />
                <StatRow
                  label="F-IMP01 実行回数"
                  value={`${stats.impactTodayCount} 回（本日）`}
                />
                <StatRow
                  label="依存整合性チェック"
                  value={
                    stats.consistencyOk ? "OK" : `不整合 ${stats.danglingCount} 件`
                  }
                  valueClass={stats.consistencyOk ? "text-[#0F766E]" : "text-error"}
                />
              </>
            ) : null}
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-white p-5">
          <h3 className="mb-3 text-sm font-bold text-on-surface">運用ルール</h3>
          <ul className="list-disc pl-[18px] text-sm leading-[1.7] text-on-surface-variant">
            <li>フェーズ追加は AI 提案のみ</li>
            <li>確定後の追加は次フェーズで対応</li>
            <li>タスク移動は影響解析 → 承認</li>
            <li>
              完了タスクへ影響時は{" "}
              <strong className="font-bold text-on-surface">
                リファクタタスク自動起票
              </strong>
            </li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
