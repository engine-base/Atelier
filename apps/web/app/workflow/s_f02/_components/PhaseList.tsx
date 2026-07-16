/**
 * S-F02 フェーズ管理 — T-UC-11
 *
 * モック (06_mockups/workflow/S-F02-phases.html) 忠実:
 * フェーズタイムライン（フェーズカード + 進捗番号 + 状態 pill + 状態変更 select）を
 * 左 2fr、右 1fr に統計 / 運用ルールを配置。データは props の実 rows にバインド。
 */

"use client";

import * as React from "react";

export type PhaseStatus = "pending" | "in_progress" | "done" | "blocked";

export interface PhaseRow {
  readonly id: string;
  readonly name: string;
  readonly status: PhaseStatus;
  readonly order: number;
}

export interface PhaseListProps {
  readonly rows: readonly PhaseRow[];
  /** 状態遷移。controlled（コンテナが API 配線して rows を更新する）。 */
  readonly onTransition?: (id: string, status: PhaseStatus) => void;
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
}

function PhaseCard({ row, onTransition }: PhaseCardProps) {
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
          <div className={metaClass}>第 {row.order} 段階</div>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${pill.pill}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${pill.dot}`} />
          {STATUS_LABEL[row.status]}
        </span>
      </div>

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

export function PhaseList({ rows, onTransition }: PhaseListProps) {
  const total = rows.length;
  const done = rows.filter((r) => r.status === "done").length;
  const inProgress = rows.filter((r) => r.status === "in_progress").length;
  const pending = rows.filter((r) => r.status === "pending").length;
  const blocked = rows.filter((r) => r.status === "blocked").length;

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[2fr_1fr]">
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-on-surface">
            フェーズタイムライン
          </h2>
        </div>
        {total === 0 ? (
          <div className="rounded-lg border border-border bg-white py-12 text-center text-on-surface-variant">
            フェーズがありません
          </div>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {rows.map((r) => (
              <PhaseCard key={r.id} row={r} onTransition={onTransition} />
            ))}
          </ol>
        )}
      </section>

      <aside className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-white p-5">
          <h3 className="mb-3 text-sm font-bold text-on-surface">統計</h3>
          <dl className="flex flex-col gap-3">
            <StatRow label="確定フェーズ数" value={`${done} / ${total}`} />
            <StatRow
              label="進行中"
              value={inProgress}
              valueClass="text-tertiary"
            />
            <StatRow label="未着手" value={pending} />
            <StatRow
              label="ブロック"
              value={blocked}
              valueClass={blocked > 0 ? "text-error" : "text-on-surface"}
            />
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
