/**
 * S-J01 承認待ち (5 種統合) — T-UC-17 / モック忠実再構築 v2
 *
 * 06_mockups/inbox/S-J01-list.html の inbox-list を忠実に再構築する:
 *   - 緊急(スコープ変更) / 通常 の 2 セクションに分けて表示
 *   - 各カード = 選択チェック + 種別アイコン面 + 種別 badge + スコア badge +
 *     依頼者 + タイトル + 2行プレビュー + 相対時刻 + クイックアクション
 *   - 行クリック (タイトルボタン) で詳細ペイン選択 (selectedId / onSelect)
 * - 承認 / 却下は onApprove / onReject prop で外部に委譲 (楽観更新は container 側)
 */

"use client";

import * as React from "react";

import { Avatar } from "../../../../components/Avatar";
import {
  EmployeeIcon,
  EMPLOYEE_IDS,
  type EmployeeId,
} from "../../../../components/EmployeeIcon";
import { cn } from "../../../../lib/cn";

// 実 DB enum (approval_inbox_type_enum) と 1:1。乖離すると全行が fallback 表示になる。
export type ApprovalKind =
  | "task_approval"
  | "phase_approval"
  | "knowledge_write"
  | "comment_response"
  | "scope_change";

export interface ApprovalRow {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly requester: string;
  /** 表示用時刻 (相対時刻 or 日付文字列)。 */
  readonly created_at: string;
  /** 2 行クランプのプレビュー本文 (payload.preview / description)。 */
  readonly preview?: string;
  /** AI 評価スコア (payload.score, 0..1)。0.95 以上は自動承認帯なので通常来ない。 */
  readonly score?: number;
}

interface KindMeta {
  /** 種別 badge / cat-tag のラベル (vitest が getByText で参照する固定文言)。 */
  readonly label: string;
  /** 種別アイコン面 (.inbox-type) と cat-tag の配色 (トークン)。 */
  readonly tone: string;
}

const KIND_META: Record<ApprovalKind, KindMeta> = {
  task_approval: {
    label: "タスク",
    tone: "bg-primary-container text-primary-container-fg",
  },
  phase_approval: {
    label: "工程",
    tone: "bg-secondary-container text-secondary-container-fg",
  },
  knowledge_write: {
    label: "ナレッジ",
    tone: "bg-tertiary-container text-tertiary-container-fg",
  },
  comment_response: {
    label: "コメント",
    tone: "bg-surface-variant text-on-surface-variant",
  },
  scope_change: {
    label: "スコープ変更",
    tone: "bg-[#FEE2E2] text-[#991B1B]",
  },
};

export interface ApprovalsListProps {
  readonly rows: readonly ApprovalRow[];
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
  /** 詳細ペインで開いている項目 (選択スタイル + チェック表示)。 */
  readonly selectedId?: string | null;
  /** 行選択 (詳細ペインを開く)。未指定なら選択 UI を出さない。 */
  readonly onSelect?: (id: string) => void;
}

function isEmployeeId(value: string): value is EmployeeId {
  return (EMPLOYEE_IDS as readonly string[]).includes(value);
}

/** 種別ごとの識別アイコン (mock の data-icon に対応する feather 相当の inline SVG)。 */
function KindIcon({ kind }: { readonly kind: ApprovalKind }) {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "scope_change":
      return (
        <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "task_approval":
      return (
        <svg {...common}>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <path d="m3 5 1.4 1.4L7 4" />
          <path d="m3 11 1.4 1.4L7 10" />
          <path d="m3 17 1.4 1.4L7 16" />
        </svg>
      );
    case "phase_approval":
      return (
        <svg {...common}>
          <path d="M6 3v12" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
      );
    case "knowledge_write":
      return (
        <svg {...common}>
          <path d="M9.5 20h5" />
          <path d="M10 23h4" />
          <path d="M12 2a7 7 0 0 0-4 12.6c.6.5 1 1.2 1 2V17h6v-.4c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z" />
        </svg>
      );
    case "comment_response":
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    default:
      return null;
  }
}

function ScoreBadge({ score }: { readonly score: number }) {
  const high = score >= 0.9;
  return (
    <span
      className={cn(
        "rounded-full px-2 py-[2px] text-[11.5px] font-bold tabular-nums",
        high
          ? "bg-tertiary-container text-tertiary-container-fg"
          : "bg-secondary-container text-secondary-container-fg",
      )}
    >
      スコア {score.toFixed(2)}
    </span>
  );
}

function ApprovalItem({
  row,
  urgent,
  selected,
  onSelect,
  onApprove,
  onReject,
}: {
  readonly row: ApprovalRow;
  readonly urgent: boolean;
  readonly selected: boolean;
  readonly onSelect?: (id: string) => void;
  readonly onApprove: (id: string) => void;
  readonly onReject: (id: string) => void;
}) {
  const meta = KIND_META[row.kind];
  return (
    <article
      onClick={onSelect ? () => onSelect(row.id) : undefined}
      className={cn(
        "grid grid-cols-[44px_1fr_auto] items-center gap-3 border-b border-border px-4 py-4 transition-colors last:border-b-0 hover:bg-surface-variant sm:grid-cols-[20px_44px_1fr_auto] sm:gap-[14px] sm:px-[18px]",
        onSelect && "cursor-pointer",
        urgent && "border-l-[3px] border-l-error pl-[15px]",
        selected && !urgent && "bg-primary-container/60",
        selected && urgent && "bg-[#FEE2E2]/60",
      )}
    >
      {/* 選択チェック (詳細ペインで開いている項目)。モバイルでは列ごと畳む。 */}
      <span
        aria-hidden="true"
        className={cn(
          "hidden h-[18px] w-[18px] items-center justify-center rounded-[4px] border-[1.5px] sm:flex",
          selected
            ? "border-primary bg-primary text-on-primary"
            : "border-border bg-white",
        )}
      >
        {selected ? (
          <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : null}
      </span>

      {/* 種別アイコン面 */}
      <span
        aria-hidden="true"
        className={cn(
          "flex h-11 w-11 items-center justify-center rounded-md",
          meta.tone,
        )}
      >
        <KindIcon kind={row.kind} />
      </span>

      {/* 本文 */}
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11.5px] text-on-surface-variant">
          <span
            className={cn(
              "rounded-full px-[9px] py-[2px] text-[11px] font-bold",
              meta.tone,
            )}
          >
            {meta.label}
          </span>
          {typeof row.score === "number" ? <ScoreBadge score={row.score} /> : null}
          {urgent ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FEE2E2] px-2.5 py-1 text-[11px] font-semibold text-[#991B1B]">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-error" />
              最優先
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            {isEmployeeId(row.requester) ? (
              <EmployeeIcon employeeId={row.requester} size="sm" />
            ) : (
              <Avatar name={row.requester} size="sm" alt={`依頼者 ${row.requester}`} />
            )}
            <span>{row.requester}</span>
          </span>
        </div>
        {onSelect ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(row.id);
            }}
            aria-expanded={selected}
            className="block w-full text-left text-[14.5px] font-bold leading-[1.45] text-on-surface hover:text-primary focus-visible:outline-2 focus-visible:outline-primary"
          >
            {row.title}
          </button>
        ) : (
          <div className="text-[14.5px] font-bold leading-[1.45] text-on-surface">
            {row.title}
          </div>
        )}
        {row.preview ? (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-[1.6] text-on-surface-variant">
            {row.preview}
          </p>
        ) : null}
      </div>

      {/* 右カラム: 日時 + クイックアクション */}
      <div className="flex flex-col items-end gap-2 self-start">
        <span className="text-[11px] tabular-nums text-on-surface-variant">
          {row.created_at}
        </span>
        {row.kind === "scope_change" && onSelect ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSelect(row.id);
            }}
            aria-label={`${row.title} を判断する`}
            className="inline-flex h-[30px] items-center rounded-md bg-primary px-3.5 text-[12px] font-bold text-on-primary transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
          >
            判断する
          </button>
        ) : (
          <div className="flex gap-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApprove(row.id);
              }}
              aria-label={`${row.title} を承認`}
              title="承認"
              className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-md bg-tertiary text-tertiary-fg transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tertiary"
            >
              <svg
                width={16}
                height={16}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onReject(row.id);
              }}
              aria-label={`${row.title} を却下`}
              title="差し戻し"
              className="inline-flex h-[30px] w-[30px] items-center justify-center rounded-md border border-border bg-white text-on-surface-variant transition hover:bg-surface-variant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
            >
              <svg
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 14 4 9l5-5" />
                <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function SectionHead({
  urgent,
  count,
  children,
}: {
  readonly urgent?: boolean;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border px-[18px] py-[10px] text-[11.5px] font-bold tracking-[0.06em]",
        urgent
          ? "bg-[#FEE2E2] text-[#991B1B]"
          : "bg-surface-variant text-on-surface-variant",
      )}
    >
      {children}
      <span
        className={cn(
          "rounded-full bg-white px-2 py-[1px] text-[11px]",
          urgent && "text-error",
        )}
      >
        {count} 件
      </span>
    </div>
  );
}

export function ApprovalsList({
  rows,
  onApprove,
  onReject,
  selectedId,
  onSelect,
}: ApprovalsListProps) {
  // スコープ変更(仕様変更の取り込み判断)は他工程をブロックするため最優先セクションへ。
  const urgentRows = rows.filter((r) => r.kind === "scope_change");
  const normalRows = rows.filter((r) => r.kind !== "scope_change");

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-md py-12 text-center text-body-md text-on-surface-variant">
        承認待ち項目はありません
      </div>
    );
  }

  return (
    <section aria-label="承認待ち一覧" className="w-full">
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        {urgentRows.length > 0 ? (
          <>
            <SectionHead urgent count={urgentRows.length}>
              最優先 — 仕様変更の取り込み判断
            </SectionHead>
            {urgentRows.map((r) => (
              <ApprovalItem
                key={r.id}
                row={r}
                urgent
                selected={r.id === selectedId}
                onSelect={onSelect}
                onApprove={onApprove}
                onReject={onReject}
              />
            ))}
          </>
        ) : null}

        {normalRows.length > 0 ? (
          <>
            <SectionHead count={normalRows.length}>
              通常 — タスク・工程・ナレッジの承認
            </SectionHead>
            {normalRows.map((r) => (
              <ApprovalItem
                key={r.id}
                row={r}
                urgent={false}
                selected={r.id === selectedId}
                onSelect={onSelect}
                onApprove={onApprove}
                onReject={onReject}
              />
            ))}
          </>
        ) : null}
      </div>
    </section>
  );
}
