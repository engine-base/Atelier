/**
 * GAP-195 — 外形監視 (S-T05)。
 *
 * これまでの実態: 自前のエラーログ (GAP-182/194) は **サーバーが生きている前提**
 * でしか書けない。Fly.io が完全に落ちたら記録も通知も残らず、復旧後に
 * 「いつからいつまで落ちていたか」を答えられなかった。
 *
 * ここに出るのは運営インフラの**外側** (GitHub Actions) から 15 分ごとに叩いた
 * 結果で、API を経由せず直接 Supabase に書かれている。だからサーバーが落ちて
 * いた時間もそのまま残る。
 *
 * 観測が 1 件も無いときに「異常なし」に見せない — それは監視が動いていない
 * だけかもしれないので、はっきりそう書く。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, CircleAlert, CircleCheck } from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { Loading } from "../../../../components/Loading";

export interface UptimeTargetStatus {
  readonly target: string;
  readonly ok: boolean;
  readonly last_checked_at: string;
  readonly since?: string | null;
  readonly availability_24h?: number | null;
  readonly checks_24h: number;
  readonly last_error?: string | null;
  readonly last_latency_ms?: number | null;
}

export interface UptimeStatusResponse {
  readonly data: readonly UptimeTargetStatus[];
  readonly interval_minutes: number;
  readonly last_observed_at?: string | null;
}

const TARGET_LABEL: Record<string, string> = {
  api: "サーバー (API)",
  web: "画面 (Web)",
};

function formatAt(value?: string | null): string {
  if (!value) return "—";
  const at = new Date(value);
  return `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, "0")}:${String(
    at.getMinutes(),
  ).padStart(2, "0")}`;
}

export interface UptimePanelProps {
  readonly client?: ApiClient;
}

export function UptimePanel({ client: injected }: UptimePanelProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const query = useQuery({
    queryKey: ["admin-uptime"],
    queryFn: async () => {
      const res = await client.get("/admin/uptime", {});
      return res as UptimeStatusResponse;
    },
    retry: false,
  });

  if (query.error instanceof ApiError && query.error.status === 403) return null;

  const status = query.data;
  const rows = status?.data ?? [];

  return (
    <section
      aria-label="外形監視"
      className="mt-6 overflow-hidden rounded-lg border border-border bg-white"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-variant px-5 py-4">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-bold text-on-surface">
            <Activity size={14} aria-hidden className="text-primary" />
            外形監視
          </div>
          <div className="mt-0.5 text-[11.5px] text-on-surface-variant">
            運営サーバーの外側から{status ? status.interval_minutes : 15}{" "}
            分ごとに確認しています（サーバーが落ちていた時間もここに残ります）
          </div>
        </div>
      </div>

      {query.isLoading ? (
        <div className="px-5 py-6">
          <Loading message="外形監視の状態を読み込み中" />
        </div>
      ) : !status ? (
        <p className="px-5 py-6 text-[13px] text-on-surface-variant">
          外形監視の状態を取得できませんでした。
        </p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-[13px] text-error">
          外からの観測がまだ 1 件もありません。監視が動いていない可能性があります
          （GitHub の uptime ワークフローと ATELIER_UPTIME_TARGETS
          の設定を確認してください）。
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <caption className="sr-only">外形監視の結果</caption>
            <thead>
              <tr className="border-b border-border text-left text-[10.5px] uppercase tracking-[0.06em] text-on-surface-variant">
                <th className="px-4 py-2 font-bold">対象</th>
                <th className="px-4 py-2 font-bold">状態</th>
                <th className="px-4 py-2 font-bold">継続</th>
                <th className="px-4 py-2 font-bold">24h 稼働率</th>
                <th className="px-4 py-2 font-bold">応答</th>
                <th className="px-4 py-2 font-bold">最終確認</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.target}
                  className="border-b border-border last:border-b-0"
                >
                  <td className="whitespace-nowrap px-4 py-2 font-semibold text-on-surface">
                    {TARGET_LABEL[r.target] ?? r.target}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {r.ok ? (
                      <span className="inline-flex items-center gap-1 text-on-surface-variant">
                        <CircleCheck size={12} aria-hidden className="text-primary" />
                        応答あり
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-semibold text-error">
                        <CircleAlert size={12} aria-hidden />
                        応答なし
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-on-surface-variant">
                    {r.since ? `${formatAt(r.since)} から` : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-on-surface-variant">
                    {r.availability_24h === null ||
                    r.availability_24h === undefined
                      ? "—"
                      : `${r.availability_24h}%`}
                    <span className="ml-1 text-[10.5px]">
                      ({r.checks_24h} 回)
                    </span>
                  </td>
                  <td className="px-4 py-2 text-on-surface-variant">
                    {r.ok
                      ? r.last_latency_ms === null ||
                        r.last_latency_ms === undefined
                        ? "—"
                        : `${r.last_latency_ms} ms`
                      : (r.last_error ?? "—")}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-on-surface-variant">
                    {formatAt(r.last_checked_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
