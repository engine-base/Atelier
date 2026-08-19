/**
 * GAP-182 — 運営向けエラーログ (Sentry を使わない選択の画面側)。
 *
 * これまでの実態: Sentry の初期化コードだけがあり main.py からも layout からも
 * 呼ばれておらず、SDK も入っていなかった。**本番で落ちても誰も気づけない**状態で、
 * それなのに docs には「Sentry EU 接続済」と書かれていた。
 *
 * 経営者判断 (2026-08-19「B で進めて」): 外部 SaaS には送らず、自前の error_log に
 * 貯めてここで見る。スタックトレースも URL も外部に出ない。追加費用ゼロ。
 */

"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { Loading } from "../../../../components/Loading";
import { cn } from "../../../../lib/cn";

export interface ErrorLogEntry {
  readonly id: string;
  readonly occurred_at: string;
  readonly source: "api" | "web" | "worker";
  readonly level: "error" | "warning";
  readonly kind: string;
  readonly message: string;
  readonly path?: string | null;
  readonly method?: string | null;
  readonly status_code?: number | null;
  readonly fingerprint: string;
  readonly count_24h: number;
}

const RANGES: readonly { label: string; hours: number }[] = [
  { label: "24 時間", hours: 24 },
  { label: "7 日", hours: 168 },
  { label: "30 日", hours: 720 },
];

const SOURCE_LABEL: Record<ErrorLogEntry["source"], string> = {
  api: "サーバー",
  web: "画面",
  worker: "バッチ",
};

export interface ErrorLogPanelProps {
  readonly client?: ApiClient;
}

export function ErrorLogPanel({ client: injected }: ErrorLogPanelProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);
  const [hours, setHours] = useState(24);

  const query = useQuery({
    queryKey: ["admin-errors", hours],
    queryFn: async () => {
      const res = await client.get("/admin/errors", {
        params: { query: { hours, limit: 50 } },
      });
      return (res as { data?: ErrorLogEntry[] }).data ?? [];
    },
    retry: false,
  });

  if (query.error instanceof ApiError && query.error.status === 403)
    return null;

  const rows = query.data ?? [];

  return (
    <section
      aria-label="エラーログ"
      className="mt-6 overflow-hidden rounded-lg border border-border bg-white"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-variant px-5 py-4">
        <div>
          <div className="text-sm font-bold text-on-surface">エラーログ</div>
          <div className="mt-0.5 text-[11.5px] text-on-surface-variant">
            外部サービスには送信していません（この画面が唯一の記録先です）
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {RANGES.map((r) => (
            <button
              key={r.hours}
              type="button"
              onClick={() => setHours(r.hours)}
              aria-pressed={hours === r.hours}
              className={cn(
                "rounded-md px-2.5 py-1 text-[11.5px] font-semibold transition-colors",
                hours === r.hours
                  ? "bg-primary text-on-primary"
                  : "text-on-surface-variant hover:bg-white",
              )}
            >
              {r.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void query.refetch()}
            aria-label="エラーログを再取得"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:bg-white"
          >
            <RefreshCw size={14} aria-hidden />
          </button>
        </div>
      </div>

      {query.isLoading ? (
        <Loading className="py-md" />
      ) : query.error ? (
        <p role="alert" className="px-5 py-4 text-body-md text-error">
          エラーログを取得できませんでした。
        </p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-on-surface-variant">
          この期間に記録されたエラーはありません。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <caption className="sr-only">記録されたエラー</caption>
            <thead>
              <tr className="border-b border-border text-left text-[10.5px] uppercase tracking-[0.06em] text-on-surface-variant">
                <th className="px-4 py-2 font-bold">発生</th>
                <th className="px-4 py-2 font-bold">場所</th>
                <th className="px-4 py-2 font-bold">種類</th>
                <th className="px-4 py-2 font-bold">内容</th>
                <th className="px-4 py-2 font-bold">24h</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const at = new Date(r.occurred_at);
                return (
                  <tr
                    key={r.id}
                    className="border-b border-border last:border-b-0"
                  >
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-on-surface-variant">
                      {`${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-on-surface-variant">
                      {SOURCE_LABEL[r.source]}
                      {r.path ? (
                        <code className="ml-1 font-mono text-[11px]">
                          {r.path}
                        </code>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-semibold text-on-surface">
                      <AlertTriangle
                        size={12}
                        aria-hidden
                        className="mr-1 inline text-error"
                      />
                      {r.kind}
                    </td>
                    <td className="px-4 py-2 text-on-surface-variant">
                      {r.message}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-on-surface-variant">
                      {r.count_24h}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
