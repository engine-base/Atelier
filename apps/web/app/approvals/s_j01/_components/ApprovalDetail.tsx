/**
 * S-J01 詳細ペイン — モック .detail-pane 忠実再構築
 *
 * 選択中の承認案件の詳細を表示する:
 *   種別 badge + 相対時刻 + タイトル + 依頼者 →
 *   何が起きたか (payload.description) → 影響範囲 (payload.impact[]) →
 *   再実行工程の選択 (payload.stages[], scope_change のみ) →
 *   メモ (resolution_note に永続) → 承認 / 却下 / あとで判断する
 *
 * 承認・却下は onDecide(decision, note) に委譲。scope_change で工程を選んだ場合は
 * 選択内容を note に含めて resolution_note へ記録する (実 API の永続フィールド)。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";

import { cn } from "../../../../lib/cn";
import type { ApprovalKind } from "./ApprovalsList";

export interface ImpactRow {
  readonly label: string;
  readonly value: string;
  readonly warn?: boolean;
}

export interface StageOption {
  readonly key: string;
  readonly label: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
}

export interface ApprovalDetailData {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly requester: string;
  readonly createdAt: string;
  readonly description?: string;
  readonly impact?: readonly ImpactRow[];
  readonly stages?: readonly StageOption[];
  readonly score?: number;
}

const KIND_LABEL: Record<ApprovalKind, string> = {
  task_approval: "タスク",
  phase_approval: "工程",
  knowledge_write: "ナレッジ",
  comment_response: "コメント",
  scope_change: "スコープ変更",
};

const KIND_TONE: Record<ApprovalKind, string> = {
  task_approval: "bg-primary-container text-primary-container-fg",
  phase_approval: "bg-secondary-container text-secondary-container-fg",
  knowledge_write: "bg-tertiary-container text-tertiary-container-fg",
  comment_response: "bg-surface-variant text-on-surface-variant",
  scope_change: "bg-[#FEE2E2] text-[#991B1B]",
};

function SectionLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[11px] font-bold tracking-[0.08em] text-on-surface-variant">
      {children}
    </div>
  );
}

export interface ApprovalDetailProps {
  readonly item: ApprovalDetailData | null;
  readonly deciding?: boolean;
  readonly onDecide: (decision: "approve" | "reject", note: string | null) => void;
  /** あとで判断する (選択解除のみ、API は呼ばない)。 */
  readonly onDefer: () => void;
}

export function ApprovalDetail({
  item,
  deciding,
  onDecide,
  onDefer,
}: ApprovalDetailProps) {
  const [note, setNote] = useState("");
  const [stageSel, setStageSel] = useState<ReadonlySet<string>>(new Set());

  // 選択項目が変わったら入力をリセットし、工程チェックは payload の初期値に合わせる
  useEffect(() => {
    setNote("");
    setStageSel(
      new Set((item?.stages ?? []).filter((s) => s.checked).map((s) => s.key)),
    );
  }, [item?.id, item?.stages]);

  if (!item) {
    return (
      <aside
        aria-label="承認詳細"
        className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-body-sm text-on-surface-variant"
      >
        リストから案件を選ぶと、詳細と判断アクションがここに表示されます。
      </aside>
    );
  }

  const urgent = item.kind === "scope_change";

  const buildNote = (): string | null => {
    const parts: string[] = [];
    if (item.stages && item.stages.length > 0) {
      const chosen = item.stages
        .filter((s) => stageSel.has(s.key))
        .map((s) => s.label);
      parts.push(
        chosen.length > 0
          ? `再実行工程: ${chosen.join(" / ")}`
          : "再実行工程: 選択なし",
      );
    }
    if (note.trim()) parts.push(note.trim());
    return parts.length > 0 ? parts.join("\n") : null;
  };

  return (
    <aside
      aria-label="承認詳細"
      className={cn(
        "rounded-lg border bg-white p-6",
        urgent ? "border-error" : "border-border",
      )}
    >
      <div className="mb-[18px] border-b border-border pb-[18px]">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "rounded-full px-[9px] py-[2px] text-[11px] font-bold",
              KIND_TONE[item.kind],
            )}
          >
            {KIND_LABEL[item.kind]}
          </span>
          <span className="text-[12px] text-on-surface-variant">
            {item.createdAt}
          </span>
        </div>
        <h2 className="mb-2 mt-2 text-[17px] font-bold leading-[1.45] tracking-[-0.01em] text-on-surface">
          {item.title}
        </h2>
        <div className="flex items-center gap-2 text-[12px] text-on-surface-variant">
          <span>{item.requester} からの承認依頼</span>
          {typeof item.score === "number" ? (
            <span className="tabular-nums">AI 評価 {item.score.toFixed(2)}</span>
          ) : null}
        </div>
      </div>

      {item.description ? (
        <div className="mb-[18px]">
          <SectionLabel>何が起きたか</SectionLabel>
          <p className="text-[13px] leading-[1.75] text-on-surface">
            {item.description}
          </p>
        </div>
      ) : null}

      {item.impact && item.impact.length > 0 ? (
        <div className="mb-[18px]">
          <SectionLabel>影響範囲</SectionLabel>
          <dl className="rounded-md bg-surface-variant px-4 py-3">
            {item.impact.map((row, i) => (
              <div
                key={row.label}
                className={cn(
                  "flex items-center justify-between py-[7px] text-[12.5px]",
                  i > 0 && "border-t border-border",
                )}
              >
                <dt className="text-on-surface-variant">{row.label}</dt>
                <dd
                  className={cn(
                    "font-bold",
                    row.warn ? "text-error" : "text-on-surface",
                  )}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {item.stages && item.stages.length > 0 ? (
        <fieldset className="mb-[18px]">
          <legend className="mb-2 text-[11px] font-bold tracking-[0.08em] text-on-surface-variant">
            再実行する工程を選んでください
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {item.stages.map((s) => {
              const checked = stageSel.has(s.key);
              return (
                <label
                  key={s.key}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-[7px] text-[12px] font-semibold",
                    s.disabled && "cursor-not-allowed opacity-55",
                    checked
                      ? "border-primary bg-primary-container text-primary-container-fg"
                      : "border-border bg-white text-on-surface",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={s.disabled}
                    onChange={(e) =>
                      setStageSel((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(s.key);
                        else next.delete(s.key);
                        return next;
                      })
                    }
                    className="m-0"
                  />
                  {s.label}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <label className="mb-1 block">
        <span className="mb-2 block text-[11px] font-bold tracking-[0.08em] text-on-surface-variant">
          メモ (任意 — 判断の記録として保存されます)
        </span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={1800}
          placeholder="差し戻し理由・承認条件など"
          className="w-full resize-y rounded-md border border-border px-3 py-2 text-body-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none"
        />
      </label>

      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          disabled={deciding}
          onClick={() => onDecide("approve", buildNote())}
          className={cn(
            "inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-3 text-[13.5px] font-bold text-white transition hover:brightness-110 disabled:opacity-50",
            urgent ? "bg-primary" : "bg-tertiary",
          )}
        >
          {urgent ? "承認して再実行を開始" : "承認する"}
        </button>
        <button
          type="button"
          disabled={deciding}
          onClick={() => onDecide("reject", buildNote())}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-border bg-white px-4 py-3 text-[13.5px] font-bold text-on-surface transition hover:bg-surface-variant disabled:opacity-50"
        >
          {urgent ? "変更を反映しない（却下）" : "差し戻す"}
        </button>
        <button
          type="button"
          onClick={onDefer}
          className="inline-flex w-full items-center justify-center rounded-md px-4 py-3 text-[13.5px] font-bold text-on-surface-variant transition hover:bg-surface-variant"
        >
          あとで判断する
        </button>
      </div>
    </aside>
  );
}
