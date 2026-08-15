/**
 * S-L01 クライアント招待管理 — T-UC-20 / design-audit v2
 *
 * client_invitations の管理。発行 / 失効 / 再発行。R-T08 関連: 招待トークンは
 * 発行時にしか平文表示せず token_hash で保存。
 *
 * モック 06_mockups/client/S-L01-invite-mgmt.html に忠実な本文構成:
 *   1. 新規招待を発行フォーム (表示名 / メール / 有効期限 / スコープ —
 *      すべて実 API (client_display_name / ttl_days / scopes) に配線。
 *      旧実装は email 以外が「黙って捨てられる死に入力」だった)
 *   2. アクティブな招待テーブル (状態 = 未使用 / 使用済)
 *   3. 履歴テーブル (状態 = 失効 / 期限切れ, surface-variant カード)
 * 失効・再送は 2 段階確認。再送 (GAP-027① 解消) は POST
 * /client-invitations/{id}/resend — token ローテーション (旧リンク失効) +
 * 新リンクをメール送付し、新 raw token を発行バナーで 1 度だけ表示する。
 * 「使用回数」列 (GAP-027② 解消) は use_count 実データ — ポータルサインイン
 * 成功ごとに client_signin が増分する。招待リンク平文は発行/再送時のみ
 * (R-T08) のため一覧では中立表示。
 */

"use client";

import * as React from "react";
import { useState } from "react";

import { cn } from "../../../../lib/cn";

export type InvitationStatus = "pending" | "used" | "revoked" | "expired";

export interface Invitation {
  readonly id: string;
  readonly email: string;
  readonly displayName?: string | null;
  readonly status: InvitationStatus;
  readonly expires_at: string;
  /** ポータルサインイン成功回数 (use_count — GAP-027②)。 */
  readonly useCount: number;
  /** 履歴の終了日 (revoked_at ?? expires_at, YYYY-MM-DD)。 */
  readonly endDate?: string;
}

/** 発行フォームの入力一式 (POST /client-invitations の body に対応)。 */
export interface IssueInput {
  readonly email: string;
  readonly displayName?: string;
  readonly ttlDays: number;
  readonly scopes: readonly string[];
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
  readonly onIssue: (input: IssueInput) => void;
  readonly onRevoke: (id: string) => void;
  /**
   * 招待メール再送 (GAP-027)。token ローテーションを伴うため 2 段階確認で呼ぶ。
   * 未指定なら再送ボタンを出さない (Rule 10)。pending 行のみ対象。
   */
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

/** 招待リンク列: 平文トークンは発行時のみ (R-T08) のため中立表示。
 * a11y: opacity での dim はコントラスト 4.5:1 を割る (axe serious) ため行わない
 * (履歴行の区別は状態 pill が担う)。 */
function InviteLinkCell({ dimmed: _dimmed }: { readonly dimmed?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-[220px] items-center gap-1.5 truncate rounded-sm bg-surface-variant px-2.5 py-1 font-mono text-[11px] text-on-surface-variant",
      )}
    >
      <LinkIcon />
      発行時のみ表示
    </span>
  );
}

/** クライアント列: 表示名 (client_display_name) + メール。 */
function ClientCell({ row }: { readonly row: Invitation }) {
  return (
    <>
      <div className="truncate font-semibold text-on-surface">
        {row.displayName || row.email}
      </div>
      {row.displayName ? (
        <div className="truncate text-[12px] text-on-surface-variant">
          {row.email}
        </div>
      ) : null}
    </>
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
      <col className="w-[24%]" />
      <col className="w-[24%]" />
      <col className="w-[14%]" />
      <col className="w-[14%]" />
      <col className="w-[12%]" />
      <col className="w-[12%]" />
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
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<string | null>(null);
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full min-w-[720px] table-fixed border-collapse">
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
            const confirming = confirmingId === r.id;
            return (
              <tr
                key={r.id}
                className="border-t border-border transition-colors hover:bg-surface-variant/40"
              >
                <td className={TD_CLASS}>
                  <ClientCell row={r} />
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
                  {r.useCount} 回
                </td>
                <td className={TD_CLASS}>
                  {confirming ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-on-surface hover:bg-surface-variant"
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onRevoke(r.id);
                          setConfirmingId(null);
                        }}
                        aria-label={`${r.email} の失効を確定`}
                        className="rounded-md bg-error px-2.5 py-1 text-[11px] font-bold text-white hover:brightness-110"
                      >
                        失効する
                      </button>
                    </div>
                  ) : resendingId === r.id ? (
                    // GAP-027: 再送は token ローテーション (旧リンク失効) を伴うため 2 段階確認
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setResendingId(null)}
                        className="rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-on-surface hover:bg-surface-variant"
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onResend?.(r.id);
                          setResendingId(null);
                        }}
                        aria-label={`${r.email} へ再送を確定 (旧リンクは失効)`}
                        className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-bold text-on-primary hover:opacity-90"
                      >
                        再送する
                      </button>
                    </div>
                  ) : (
                    <div className="flex justify-end gap-1">
                      {onResend && r.status === "pending" ? (
                        <button
                          type="button"
                          onClick={() => setResendingId(r.id)}
                          aria-label={`${r.email} へ招待メールを再送`}
                          title="再送 (新しいリンクを発行して送付)"
                          className={cn(GHOST_BTN, "hover:bg-primary-container hover:text-primary")}
                        >
                          <MailIcon />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setConfirmingId(r.id)}
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
                  )}
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
  onReissue,
}: {
  readonly rows: readonly Invitation[];
  readonly onReissue: (row: Invitation) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-white">
      <table className="w-full min-w-[720px] table-fixed border-collapse">
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
                <ClientCell row={r} />
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
                {r.endDate ?? r.expires_at}
              </td>
              <td className={cn(TD_CLASS, "tabular-nums text-on-surface-variant")}>
                {r.useCount} 回
              </td>
              <td className={TD_CLASS}>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => onReissue(r)}
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
  const [displayName, setDisplayName] = useState("");
  const [ttlDays, setTtlDays] = useState(7);
  const [scope, setScope] = useState<"view_comment" | "view">("view_comment");

  const active = invitations.filter((i) => ACTIVE_STATUSES.includes(i.status));
  const history = invitations.filter(
    (i) => !ACTIVE_STATUSES.includes(i.status),
  );

  const scopesOf = (s: "view_comment" | "view"): readonly string[] =>
    s === "view" ? ["view"] : ["view", "comment"];

  const inputClass =
    "h-10 rounded-md border border-border bg-surface px-3 text-body-md text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none";
  const labelTextClass = "text-label-md font-medium text-on-surface-variant";

  return (
    <div className="flex flex-col gap-8">
      {/* 1. 新規招待を発行 (全入力を実 API パラメータへ配線) */}
      <section className="rounded-lg border border-border bg-white p-6">
        <h2 className="mb-4 text-base font-bold text-on-surface">
          新規招待を発行
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!email) return;
            onIssue({
              email,
              displayName: displayName.trim() || undefined,
              ttlDays,
              scopes: scopesOf(scope),
            });
            setEmail("");
            setDisplayName("");
          }}
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className={labelTextClass}>クライアント表示名</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
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
              <select
                value={String(ttlDays)}
                onChange={(e) => setTtlDays(Number(e.target.value))}
                className={inputClass}
              >
                <option value="3">3 日</option>
                <option value="7">7 日（推奨）</option>
                <option value="14">14 日</option>
                <option value="30">30 日</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={labelTextClass}>スコープ</span>
              <select
                value={scope}
                onChange={(e) =>
                  setScope(e.target.value === "view" ? "view" : "view_comment")
                }
                className={inputClass}
              >
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
          <HistoryTable
            rows={history}
            onReissue={(row) =>
              onIssue({
                email: row.email,
                displayName: row.displayName ?? undefined,
                ttlDays: 7,
                scopes: ["view", "comment"],
              })
            }
          />
        )}
      </section>
    </div>
  );
}
