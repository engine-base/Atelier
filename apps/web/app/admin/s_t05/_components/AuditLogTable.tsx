/**
 * S-T05 監査ログ — T-UC-34
 *
 * audit_logs (E-020) を表示。action / actor_type+actor_id / target / ip / created_at。
 * モック 06_mockups/admin/S-T05-audit.html に忠実な本文:
 *   集計カード(本日/AI/ユーザー/致命級) + フィルタバー + ログ表(時刻・アクター・アクション・対象・IP)。
 * フィルタ: 検索(action / actor_id の部分一致)。アクター/アクション/WS/日付の select は将来配線。
 */

"use client";

import * as React from "react";
import { useState } from "react";

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly actor_type: "user" | "ai" | "system" | "anonymous";
  readonly actor_id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly ip_address: string | null;
  readonly created_at: string;
}

export interface AuditLogTableProps {
  readonly entries: readonly AuditEntry[];
}

/** アクター種別 → バッジ/アバターの配色・ラベル。 */
const ACTOR: Record<
  AuditEntry["actor_type"],
  { readonly label: string; readonly badge: string; readonly avatar: string }
> = {
  ai: {
    label: "AI",
    badge: "bg-tertiary-container text-on-tertiary-container",
    avatar: "bg-tertiary text-on-tertiary",
  },
  user: {
    label: "USER",
    badge: "bg-primary-container text-on-primary-container",
    avatar: "bg-primary text-on-primary",
  },
  system: {
    label: "SYS",
    badge: "bg-surface-variant text-on-surface-variant",
    avatar: "bg-surface-variant text-on-surface-variant",
  },
  anonymous: {
    label: "ANON",
    badge: "bg-surface-variant text-on-surface-variant",
    avatar: "bg-surface-variant text-on-surface-variant",
  },
};

const ROW_GRID = "grid grid-cols-[130px_90px_1fr_1.5fr_100px_40px] items-center gap-[14px]";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function initial(id: string): string {
  return id.charAt(0).toUpperCase() || "?";
}

function StatCard({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-5">
      <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
        {label}
      </div>
      <div className={`mt-1 text-3xl font-bold tabular-nums ${tone ?? "text-on-surface"}`}>
        {value}
      </div>
    </div>
  );
}

function LogRow({ entry }: { readonly entry: AuditEntry }) {
  const actor = ACTOR[entry.actor_type];
  return (
    <div className={`${ROW_GRID} border-b border-border px-[18px] py-3 text-[12.5px] hover:bg-surface-variant`}>
      <div className="font-mono text-[11.5px] text-on-surface-variant">
        {formatTime(entry.created_at)}
      </div>
      <div className="flex items-center gap-1">
        <span
          className={`inline-flex items-center rounded-sm px-[7px] py-px text-[10px] font-bold uppercase tracking-[0.04em] ${actor.badge}`}
        >
          {actor.label}
        </span>
        <span
          aria-hidden="true"
          title={entry.actor_id}
          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${actor.avatar}`}
        >
          {initial(entry.actor_id)}
        </span>
      </div>
      <div className="min-w-0">
        <div className="truncate font-mono text-[12px] font-semibold text-on-surface">
          {entry.action}
        </div>
        <div className="truncate font-mono text-[10.5px] text-on-surface-variant">
          {entry.actor_type}:{entry.actor_id}
        </div>
      </div>
      <div className="min-w-0">
        <div className="truncate font-mono text-[12.5px] text-on-surface">
          {entry.target_type}:{entry.target_id || "—"}
        </div>
      </div>
      <div>
        <span className="inline-flex items-center rounded-sm bg-surface-variant px-2 py-0.5 font-mono text-[10.5px] font-semibold text-on-surface-variant">
          {entry.ip_address ?? "—"}
        </span>
      </div>
      {/* 監査ログは読み取り専用のため行アクション(⋯)は持たない。 */}
      <div />
    </div>
  );
}

export function AuditLogTable({ entries }: AuditLogTableProps) {
  const [query, setQuery] = useState("");
  // データは取得済みのため actor / action 絞り込みはクライアント側で実行(API不要)。
  const [actorType, setActorType] = useState<"all" | AuditEntry["actor_type"]>(
    "all",
  );
  const [actionType, setActionType] = useState("all");
  const [dateFilter, setDateFilter] = useState(""); // YYYY-MM-DD
  const filtered = entries.filter((e) => {
    const matchesQuery =
      query === "" || e.action.includes(query) || e.actor_id.includes(query);
    const matchesActor = actorType === "all" || e.actor_type === actorType;
    const matchesAction = actionType === "all" || e.action.includes(actionType);
    // created_at は ISO のため先頭10文字(YYYY-MM-DD)で日付一致を見る。
    const matchesDate = dateFilter === "" || e.created_at.slice(0, 10) === dateFilter;
    return matchesQuery && matchesActor && matchesAction && matchesDate;
  });

  const aiCount = entries.filter((e) => e.actor_type === "ai").length;
  const userCount = entries.filter((e) => e.actor_type === "user").length;

  return (
    <section className="flex flex-col">
      {/* 集計カード */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {/* 当日絞り込みは未実装のため「本日の操作」ではなく総件数として表示 */}
        <StatCard label="操作件数" value={entries.length.toLocaleString()} />
        <StatCard label="AI 操作" value={aiCount.toLocaleString()} tone="text-tertiary" />
        <StatCard
          label="ユーザー操作"
          value={userCount.toLocaleString()}
          tone="text-primary"
        />
        <StatCard label="致命級アラート" value="0" tone="text-on-surface-variant" />
      </div>

      {/* フィルタバー */}
      <div className="mb-[14px] flex flex-wrap items-center gap-[10px] rounded-md border border-border bg-white px-4 py-3">
        <label className="flex min-w-[200px] flex-1 items-center gap-2">
          <span className="sr-only">action / actor 検索</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4 text-on-surface-variant"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="search"
            placeholder="action / actor で絞り込み"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 border-none bg-transparent text-body-md text-on-surface outline-none placeholder:text-on-surface-variant"
          />
        </label>
        <select
          aria-label="アクターで絞り込み"
          value={actorType}
          onChange={(e) =>
            setActorType(e.target.value as "all" | AuditEntry["actor_type"])
          }
          className="rounded-md border border-border bg-white px-3 py-1.5 text-[12px] text-on-surface"
        >
          <option value="all">全アクター</option>
          <option value="ai">AI</option>
          <option value="user">User</option>
          <option value="system">System</option>
        </select>
        <select
          aria-label="アクションで絞り込み"
          value={actionType}
          onChange={(e) => setActionType(e.target.value)}
          className="rounded-md border border-border bg-white px-3 py-1.5 text-[12px] text-on-surface"
        >
          <option value="all">全アクション</option>
          <option value="create">create</option>
          <option value="update">update</option>
          <option value="delete">delete</option>
          <option value="access">access</option>
        </select>
        {/* WS 絞り込み select は選択肢が「全 WS」1 個だけの死に要素だったため撤去
            (Rule 10)。WS 一覧 API を audit-logs のフィルタに配線する時に復活させる。 */}
        <input
          type="date"
          aria-label="日付で絞り込み"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          className="rounded-md border border-border bg-white px-2.5 py-1.5 text-[12px] text-on-surface"
        />
        {dateFilter || actorType !== "all" || actionType !== "all" || query ? (
          <button
            type="button"
            aria-label="絞り込みをクリア"
            title="絞り込みをクリア"
            onClick={() => {
              setQuery("");
              setActorType("all");
              setActionType("all");
              setDateFilter("");
            }}
            className="inline-flex h-8 items-center rounded-md px-2 text-[12px] font-semibold text-on-surface transition-colors hover:bg-surface-variant"
          >
            クリア
          </button>
        ) : null}
      </div>

      {/* ログ表 (幅が要る表なので、はみ出しは body でなく表自身が横スクロールする) */}
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <div className="min-w-[720px]">
        <div
          className={`${ROW_GRID} border-b border-border bg-surface-variant px-[18px] py-3 text-[10.5px] font-bold uppercase tracking-[0.06em] text-on-surface-variant`}
        >
          <div>時刻</div>
          <div>アクター</div>
          <div>アクション</div>
          <div>対象</div>
          <div>IP</div>
          <div />
        </div>

        {filtered.length === 0 ? (
          <div className="px-[18px] py-12 text-center text-body-md text-on-surface-variant">
            監査ログがありません
          </div>
        ) : (
          filtered.map((entry) => <LogRow key={entry.id} entry={entry} />)
        )}

        <div className="border-t border-border px-[18px] py-3 text-center text-[13px] text-on-surface-variant">
          <span className="tabular-nums">
            {entries.length.toLocaleString()} 件中{" "}
            {filtered.length.toLocaleString()} 件表示
          </span>
        </div>
        </div>
      </div>
    </section>
  );
}
