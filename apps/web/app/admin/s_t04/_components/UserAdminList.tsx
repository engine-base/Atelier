/**
 * S-T04 ユーザー管理 — T-UC-33 / F-VIS 是正 (presentational)
 *
 * モック 06_mockups/admin/S-T04-users.html に忠実な本文で描画する:
 *   統計カード(4) + フィルタバー(検索/状態/CSV) + ユーザー一覧テーブル
 *   (avatar + ユーザー + WS/ロール + プラン + 最終ログイン + サポート + 状態pill + アクション)。
 *
 * データは実 props (`users`) にバインドする。API が持たない列 (WS/ロール・プラン・サポート)
 * はモックの「—」表記に倣ってプレースホルダ表示。停止/復元 action は callback 注入時のみ。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";

import { cn } from "../../../../lib/cn";

export type UserState = "active" | "suspended" | "deleted";

export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly state: UserState;
  readonly last_login: string | null;
}

const STATE_LABEL: Record<UserState, string> = {
  active: "有効",
  suspended: "停止中",
  deleted: "削除済",
};

/** 状態 pill の配色 (atelier.css の pill-completed / -awaiting / -blocked を踏襲)。 */
const STATE_PILL: Record<UserState, { readonly tone: string; readonly dot: string }> = {
  active: { tone: "bg-tertiary-container text-tertiary-container-fg", dot: "bg-tertiary" },
  suspended: { tone: "bg-secondary-container text-secondary-container-fg", dot: "bg-secondary" },
  deleted: { tone: "bg-[#FEE2E2] text-[#991B1B]", dot: "bg-error" },
};

/** 状態フィルタの選択肢 (モック文言)。値は実 state / all にマップ。 */
const STATUS_OPTIONS: readonly { readonly value: UserState | "all"; readonly label: string }[] = [
  { value: "all", label: "全ステータス" },
  { value: "active", label: "アクティブ" },
  { value: "suspended", label: "退会予約" },
  { value: "deleted", label: "削除済み" },
];

const AVATAR_PALETTE = [
  "bg-primary text-on-primary",
  "bg-secondary text-on-secondary",
  "bg-tertiary text-on-tertiary",
] as const;

function hashString(value: string): number {
  let acc = 0;
  for (let i = 0; i < value.length; i += 1) acc = (acc + value.charCodeAt(i)) % 997;
  return acc;
}

function avatarTone(user: AdminUser): string {
  if (user.state === "deleted") return "bg-neutral text-on-neutral";
  return AVATAR_PALETTE[hashString(user.id) % AVATAR_PALETTE.length]!;
}

export interface UserAdminListProps {
  readonly users: readonly AdminUser[];
  /** 停止/復元。いずれも未指定なら「アクション」列を出さない（read-only 時など）。 */
  readonly onSuspend?: (id: string) => void;
  readonly onRestore?: (id: string) => void;
}

/** 一覧テーブルのグリッド列 (モック .user-row の grid-template-columns 準拠)。 */
const GRID_COLS =
  "grid-cols-[40px_1.5fr_1fr_80px_1fr_100px_80px_auto]";

function StatCard({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
        {label}
      </div>
      <div className={cn("mt-1 text-3xl font-bold tabular-nums", tone ?? "text-on-surface")}>
        {value}
      </div>
    </div>
  );
}

function HeaderRow() {
  const labels = ["", "ユーザー", "WS / ロール", "プラン", "最終ログイン", "サポート", "状態", ""];
  return (
    <div
      className={cn(
        "grid items-center gap-[14px] bg-surface-variant px-[18px] py-[14px]",
        "text-[10.5px] font-bold uppercase tracking-[0.06em] text-on-surface-variant",
        GRID_COLS,
      )}
    >
      {labels.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

function StatePill({ state }: { readonly state: UserState }) {
  const pill = STATE_PILL[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        pill.tone,
      )}
    >
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", pill.dot)} />
      {STATE_LABEL[state]}
    </span>
  );
}

function ActionCell({
  user,
  onSuspend,
  onRestore,
}: {
  readonly user: AdminUser;
  readonly onSuspend?: (id: string) => void;
  readonly onRestore?: (id: string) => void;
}) {
  if (onSuspend && user.state === "active") {
    return (
      <button
        type="button"
        onClick={() => onSuspend(user.id)}
        aria-label={`${user.email} を停止`}
        className="inline-flex h-7 items-center rounded-md border border-error px-2 text-[11px] font-semibold text-error transition-colors hover:bg-error/10 focus-visible:outline-2 focus-visible:outline-error"
      >
        停止
      </button>
    );
  }
  if (onRestore && user.state === "suspended") {
    return (
      <button
        type="button"
        onClick={() => onRestore(user.id)}
        aria-label={`${user.email} を復元`}
        className="inline-flex h-7 items-center rounded-md bg-tertiary-container px-2 text-[11px] font-semibold text-tertiary-container-fg transition-colors hover:bg-tertiary-container/80 focus-visible:outline-2 focus-visible:outline-tertiary"
      >
        復元
      </button>
    );
  }
  return <span className="text-on-surface-variant">—</span>;
}

function UserRow({
  user,
  hasActions,
  onSuspend,
  onRestore,
}: {
  readonly user: AdminUser;
  readonly hasActions: boolean;
  readonly onSuspend?: (id: string) => void;
  readonly onRestore?: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        "grid items-center gap-[14px] border-b border-border px-[18px] py-[14px] text-[13px] transition-colors hover:bg-surface-variant",
        GRID_COLS,
        user.state === "deleted" && "opacity-55",
      )}
    >
      {/* avatar */}
      <div
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-full text-[13px] font-bold",
          avatarTone(user),
        )}
        aria-hidden="true"
      >
        {user.email.charAt(0).toUpperCase()}
      </div>

      {/* ユーザー (メール + ID) */}
      <div className="min-w-0">
        <div className="truncate font-bold text-on-surface">{user.email}</div>
        <div className="truncate text-[12px] tabular-nums text-on-surface-variant">{user.id}</div>
      </div>

      {/* WS / ロール (API 未提供 → プレースホルダ) */}
      <div className="text-on-surface-variant">—</div>

      {/* プラン (API 未提供 → neutral badge) */}
      <div>
        <span className="inline-flex items-center rounded-sm bg-surface-variant px-2 py-0.5 text-[10.5px] font-semibold text-on-surface-variant">
          —
        </span>
      </div>

      {/* 最終ログイン */}
      <div className="tabular-nums text-on-surface">{user.last_login ?? "—"}</div>

      {/* サポート (API 未提供 → プレースホルダ) */}
      <div className="text-on-surface-variant">—</div>

      {/* 状態 */}
      <div>
        <StatePill state={user.state} />
      </div>

      {/* アクション (callback 注入時のみ機能) */}
      <div className="text-right">
        {hasActions ? (
          <ActionCell user={user} onSuspend={onSuspend} onRestore={onRestore} />
        ) : null}
      </div>
    </div>
  );
}

export function UserAdminList({ users, onSuspend, onRestore }: UserAdminListProps) {
  const hasActions = Boolean(onSuspend || onRestore);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<UserState | "all">("all");

  const counts = useMemo(
    () => ({
      total: users.length,
      active: users.filter((u) => u.state === "active").length,
      suspended: users.filter((u) => u.state === "suspended").length,
      deleted: users.filter((u) => u.state === "deleted").length,
    }),
    [users],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      const matchesQuery = q === "" || u.email.toLowerCase().includes(q);
      const matchesStatus = status === "all" || u.state === status;
      return matchesQuery && matchesStatus;
    });
  }, [users, query, status]);

  function handleExport(): void {
    const rows = filtered.map(
      (u) => `${u.email},${u.state},${u.last_login ?? ""}`,
    );
    const csv = ["email,state,last_login", ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "users.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col">
      {/* 統計カード */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="総ユーザー" value={counts.total} />
        <StatCard label="アクティブ" value={counts.active} tone="text-tertiary" />
        <StatCard label="退会予約" value={counts.suspended} tone="text-secondary" />
        <StatCard label="削除済み" value={counts.deleted} tone="text-on-surface-variant" />
      </div>

      {/* フィルタバー */}
      <div className="mb-[14px] flex flex-wrap items-center gap-[10px] rounded-md border border-border bg-white px-4 py-3">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0 text-on-surface-variant"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="メール / 名前 / WS で検索"
          aria-label="ユーザー検索"
          className="min-w-0 flex-1 border-none bg-transparent text-[13px] text-on-surface outline-none placeholder:text-on-surface-variant"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as UserState | "all")}
          aria-label="状態で絞り込み"
          className="rounded-sm border border-border bg-white px-3 py-1.5 text-[12px] text-on-surface"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={handleExport}
          className="inline-flex items-center gap-1.5 rounded-md border border-primary px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-primary"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          CSV エクスポート
        </button>
      </div>

      {/* ユーザー一覧テーブル */}
      <div className="overflow-hidden rounded-lg border border-border bg-white">
        <div className="overflow-x-auto">
          <div className="min-w-[880px]">
            <HeaderRow />
            {filtered.length === 0 ? (
              <div className="py-12 text-center text-body-md text-on-surface-variant">
                ユーザーがいません
              </div>
            ) : (
              filtered.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  hasActions={hasActions}
                  onSuspend={onSuspend}
                  onRestore={onRestore}
                />
              ))
            )}
          </div>
        </div>
        {filtered.length > 0 ? (
          <div className="border-t border-border px-[18px] py-3 text-center text-[13px] tabular-nums text-on-surface-variant">
            {counts.total} 名中 {filtered.length} 名表示
          </div>
        ) : null}
      </div>
    </div>
  );
}
