/**
 * S-L01 クライアント招待管理 — T-UC-20 / F-VIS 是正
 *
 * client_invitations の管理。発行 / 失効 / 再送。R-T08 関連: 招待トークンは
 * 発行時にしか平文表示せず token_hash で保存。
 *
 * モック 06_mockups/client/S-L01-invite-mgmt.html に忠実な本文構成:
 *   1. 新規招待を発行フォーム (invite-form カード)
 *   2. アクティブな招待テーブル (状態 = 未使用 / 使用中)
 *   3. 履歴テーブル (状態 = 失効 / 期限切れ, surface-variant カード)
 * 状態 pill は atelier.css の .pill-* を踏襲。データは実 props にバインドする
 * (表示名・招待リンク平文・使用回数は API 契約に存在しないため中立表示)。
 */

"use client";

import * as React from "react";
import { useState } from "react";

import { cn } from "../../../../lib/cn";

export type InvitationStatus = "pending" | "used" | "revoked" | "expired";

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly status: InvitationStatus;
  readonly expires_at: string;
}

const STATUS_LABEL: Record<InvitationStatus, string> = {
  pending: "未使用",
  used: "使用済",
  revoked: "失効",
  expired: "期限切れ",
};

/** 状態 pill 配色 (atelier.css .pill-pending/.pill-completed/.pill-blocked 相当)。 */
const STATUS_PILL: Record<InvitationStatus, string> = {
  pending: "bg-surface-variant text-on-surface-variant",
  used: "bg-tertiary-container text-tertiary-container-fg",
  revoked: "bg-[#FEE2E2] text-[#991B1B]",
  expired: "bg-[#FEE2E2] text-[#991B1B]",
};

const STATUS_DOT: Record<InvitationStatus, string> = {
  pending: "bg-on-surface-variant",
  used: "bg-tertiary",
  revoked: "bg-error",
  expired: "bg-error",
};

const ACTIVE_STATUSES: readonly InvitationStatus[] = ["pending", "used"];

export interface InvitationsListProps {
  readonly invitations: readonly Invitation[];
  readonly onIssue: (email: string) => void;
  readonly onRevoke: (id: string) => void;
  /** 再送 API が無いため optional。未指定なら再送ボタンは表示しない。 */
  readonly onResend?: (id: string) => void;
}

const MS_PER_DAY = 86_400_000;

function daysRemaining(dateStr: string): number {
  const target = new Date(dateStr).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.ceil((target - Date.now()) / MS_PER_DAY);
}

function MailIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-3 w-3 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M6 6v14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V6" />
    </svg>
  );
}

function RotateCwIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  );
}

function StatusPill({ status }: { readonly status: InvitationStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        STATUS_PILL[status],
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** 招待リンク列: 平文トークンは発行時のみ (R-T08) のため中立表示。 */
function InviteLinkCell({ dimmed }: { readonly dimmed?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[220px] items-center gap-1.5 truncate rounded-sm bg-surface-variant px-2.5 py-1 font-mono text-[11px] text-on-surface-variant",
        dimmed && "opacity-50",
      )}
    >
      <LinkIcon />
      発行時のみ表示
    </span>
  );
}

const TH_CLASS =
  "bg-surface-variant px-4 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-on-surface-variant";
const TD_CLASS = "px-4 py-3.5 align-middle text-body-sm text-on-surface";
const GHOST_BTN =
  "inline-flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-variant focus-visible:outline-2 focus-visible:outline-primary";

function InviteColgroup() {
  return (
    <colgroup>
      <col className="w-[22%]" />
      <col className="w-[28%]" />
      <col className="w-[14%]" />
      <col className="w-[14%]" />
      <col className="w-[12%]" />
      <col className="w-[10%]" />
    </colgroup>
  );
}

function ActiveTable({
  rows,
  onRevoke,
  onResend,
}: {
  readonly rows: readonly Invitation[];
  readonly onRevoke: (id: string) => void;
  readonly onResend?: (id: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-white">
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">アクティブな招待</caption>
        <InviteColgroup />
        <thead>
          <tr>
            <th className={TH_CLASS}>クライアント</th>
            <th className={TH_CLASS}>招待リンク</th>
            <th className={TH_CLASS}>状態</th>
            <th className={TH_CLASS}>有効期限</th>
            <th className={TH_CLASS}>使用回数</th>
            <th className={TH_CLASS} aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const remaining = daysRemaining(r.expires_at);
            return (
              <tr
                key={r.id}
                className="border-t border-border transition-colors hover:bg-surface-variant/40"
              >
                <td className={TD_CLASS}>
                  <div className="truncate font-semibold text-on-surface">
                    {r.email}
                  </div>
                </td>
                <td className={TD_CLASS}>
                  <InviteLinkCell />
                </td>
                <td className={TD_CLASS}>
                  <StatusPill status={r.status} />
                </td>
                <td className={cn(TD_CLASS, "tabular-nums")}>
                  {remaining > 0 ? `残り ${remaining} 日` : "期限切れ"}
                </td>
                <td
                  className={cn(TD_CLASS, "tabular-nums text-on-surface-variant")}
                >
                  —
                </td>
                <td className={TD_CLASS}>
                  <div className="flex justify-end gap-1">
                    {onResend && r.status === "pending" ? (
                      <button
                        type="button"
                        onClick={() => onResend(r.id)}
                        aria-label={`${r.email} に再送`}
                        title="再送"
                        className={GHOST_BTN}
                      >
                        <MailIcon />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onRevoke(r.id)}
                      aria-label={`${r.email} を失効`}
                      title="失効"
                      className={cn(
                        GHOST_BTN,
                        "hover:bg-[#FEE2E2] hover:text-error",
                      )}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({
  rows,
  onIssue,
}: {
  readonly rows: readonly Invitation[];
  readonly onIssue: (email: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-white">
      <table className="w-full table-fixed border-collapse">
        <caption className="sr-only">履歴（失効・期限切れ）</caption>
        <InviteColgroup />
        <thead>
          <tr>
            <th className={TH_CLASS}>クライアント</th>
            <th className={TH_CLASS}>招待リンク</th>
            <th className={TH_CLASS}>状態</th>
            <th className={TH_CLASS}>終了日</th>
            <th className={TH_CLASS}>使用回数</th>
            <th className={TH_CLASS} aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-t border-border transition-colors hover:bg-surface-variant/40"
            >
              <td className={TD_CLASS}>
                <div className="truncate font-semibold text-on-surface">
                  {r.email}
                </div>
              </td>
              <td className={TD_CLASS}>
                <InviteLinkCell dimmed />
              </td>
              <td className={TD_CLASS}>
                <StatusPill status={r.status} />
              </td>
              <td
                className={cn(TD_CLASS, "tabular-nums text-on-surface-variant")}
              >
                {r.expires_at}
              </td>
              <td className={cn(TD_CLASS, "tabular-nums text-on-surface-variant")}>
                —
              </td>
              <td className={TD_CLASS}>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => onIssue(r.email)}
                    aria-label={`${r.email} を再発行`}
                    title="再発行"
                    className={GHOST_BTN}
                  >
                    <RotateCwIcon />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InvitationsList({
  invitations,
  onIssue,
  onRevoke,
  onResend,
}: InvitationsListProps) {
  const [email, setEmail] = useState("");

  const active = invitations.filter((i) => ACTIVE_STATUSES.includes(i.status));
  const history = invitations.filter(
    (i) => !ACTIVE_STATUSES.includes(i.status),
  );

  const inputClass =
    "h-10 rounded-md border border-border bg-surface px-3 text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none";
  const labelTextClass = "text-label-md font-medium text-on-surface-variant";

  return (
    <div className="flex flex-col gap-8">
      {/* 1. 新規招待を発行 */}
      <section className="rounded-lg border border-border bg-white p-6">
        <h2 className="mb-4 text-base font-bold text-on-surface">
          新規招待を発行
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!email) return;
            onIssue(email);
            setEmail("");
          }}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className={labelTextClass}>クライアント表示名</span>
              <input
                type="text"
                placeholder="例：小松 太郎"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={labelTextClass}>招待メールアドレス</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="client@example.com"
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={labelTextClass}>有効期限（日）</span>
              <select className={inputClass} defaultValue="7">
                <option value="3">3 日</option>
                <option value="7">7 日（推奨）</option>
                <option value="14">14 日</option>
                <option value="30">30 日</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={labelTextClass}>スコープ</span>
              <select className={inputClass} defaultValue="view_comment">
                <option value="view_comment">閲覧 + コメント（推奨）</option>
                <option value="view">閲覧のみ</option>
              </select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!email}
              className="inline-flex h-10 items-center gap-1.5 rounded-md bg-primary px-4 text-label-lg font-semibold text-on-primary transition-colors hover:bg-[#1E54D8] focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
            >
              <MailIcon />
              招待を発行
            </button>
            <span className="text-body-sm text-on-surface-variant">
              発行後に招待リンクを表示します（メール設定済みの環境では自動送信も行います）
            </span>
          </div>
        </form>
      </section>

      {/* 2. アクティブな招待 */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-on-surface">
            アクティブな招待（{active.length}）
          </h2>
        </div>
        {active.length === 0 ? (
          <div className="rounded-lg border border-border bg-white py-12 text-center text-body-md text-on-surface-variant">
            アクティブな招待がありません
          </div>
        ) : (
          <ActiveTable rows={active} onRevoke={onRevoke} onResend={onResend} />
        )}
      </section>

      {/* 3. 履歴（失効・期限切れ） */}
      <section className="rounded-lg bg-surface-variant p-5">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-base font-bold text-on-surface">
              履歴（失効・期限切れ）
            </h2>
            <p className="mt-1 text-body-sm text-on-surface-variant">
              過去 90 日以内に終了した招待リンク
            </p>
          </div>
          <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-on-surface-variant">
            {history.length} 件
          </span>
        </div>
        {history.length === 0 ? (
          <div className="rounded-md border border-border bg-white py-12 text-center text-body-md text-on-surface-variant">
            終了した招待はありません
          </div>
        ) : (
          <HistoryTable rows={history} onIssue={onIssue} />
        )}
      </section>
    </div>
  );
}
