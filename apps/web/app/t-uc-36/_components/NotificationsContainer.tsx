/**
 * T-UC-36 通知センター コンテナ — 実 approval-inbox API 配線
 *
 * 通知の主要ソースである「本人の承認待ち（GET /approval-inbox, RLS 本人限定）」を
 * 通知として一覧表示する。既読状態は専用テーブルを持たず localStorage で管理する
 * （新規テーブル + RLS は R-T08 致命級・別途 migration が必要なため本 MVP では回避）。
 * client はテスト用に注入可能。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../lib/auth/connector";
import { cn } from "../../../lib/cn";

interface ApiApproval {
  id: string;
  title: string;
  created_at: string;
}

interface NotificationItem {
  readonly id: string;
  readonly message: string;
  readonly createdAt: string;
  readonly read: boolean;
}

const READ_KEY = "atelier_read_notifications";

function readDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function persistDismissed(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(READ_KEY, JSON.stringify([...ids]));
}

export interface NotificationsContainerProps {
  readonly client?: ApiClient;
}

export function NotificationsContainer({
  client: injected,
}: NotificationsContainerProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    readDismissed(),
  );
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const inbox = useQuery({
    queryKey: ["notifications", "approval-inbox"],
    queryFn: async () => {
      const res = await client.get("/approval-inbox");
      return (res as { data?: ApiApproval[] }).data ?? [];
    },
    retry: false,
  });

  const markRead = (id: string): void => {
    setDismissed((prev) => {
      const next = new Set(prev).add(id);
      persistDismissed(next);
      return next;
    });
  };

  if (inbox.error instanceof ApiError && inbox.error.status === 403) {
    return (
      <p role="alert" className="text-body-md text-error">
        通知を表示する権限がありません。
      </p>
    );
  }
  if (inbox.error) {
    return (
      <p role="alert" className="text-body-md text-error">
        通知の取得に失敗しました。
      </p>
    );
  }
  if (inbox.isLoading) {
    return <p className="text-body-md text-on-surface-variant">読み込み中…</p>;
  }

  const items: NotificationItem[] = (inbox.data ?? []).map((a) => ({
    id: a.id,
    message: a.title,
    createdAt: a.created_at.slice(0, 16).replace("T", " "),
    read: dismissed.has(a.id),
  }));
  const visible = filter === "all" ? items : items.filter((n) => !n.read);
  const unreadCount = items.filter((n) => !n.read).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-md px-md py-lg">
      <header className="flex items-center justify-between">
        <h1 className="text-headline-md font-bold text-on-surface">
          通知センター
        </h1>
        <span
          aria-label={`未読 ${unreadCount} 件`}
          className="text-label-md text-on-surface-variant"
        >
          未読 {unreadCount}
        </span>
      </header>
      <div role="tablist" aria-label="フィルタ" className="flex gap-xs">
        {(["all", "unread"] as const).map((f) => (
          <button
            key={f}
            role="tab"
            aria-selected={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "inline-flex h-8 items-center rounded-sm px-sm text-label-md",
              filter === f
                ? "bg-primary text-primary-fg"
                : "bg-surface-variant text-on-surface",
            )}
          >
            {f === "all" ? "すべて" : "未読のみ"}
          </button>
        ))}
      </div>
      <ul role="list" className="flex flex-col gap-sm">
        {visible.length === 0 ? (
          <li className="text-body-md text-on-surface-variant">
            通知はありません
          </li>
        ) : (
          visible.map((n) => (
            <li
              key={n.id}
              className={cn(
                "flex items-start justify-between border-l-4 border-l-surface-variant bg-surface px-md py-sm shadow-[var(--shadow-e1)]",
                !n.read && "font-semibold",
              )}
            >
              <div className="flex flex-col">
                <p className="text-body-sm text-on-surface">{n.message}</p>
                <time className="text-label-sm text-on-surface-variant">
                  {n.createdAt}
                </time>
              </div>
              {!n.read ? (
                <button
                  type="button"
                  onClick={() => markRead(n.id)}
                  aria-label={`${n.message} を既読にする`}
                  className="inline-flex h-7 items-center rounded-sm border border-surface-variant px-sm text-label-sm"
                >
                  既読
                </button>
              ) : null}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
