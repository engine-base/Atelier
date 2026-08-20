/**
 * GAP-194 — エラー通知の状態 (S-T05)。
 *
 * これまでの実態: GAP-182 でエラーは記録されるようになったが **誰にも届かない**。
 * この画面を開きに来ない限り、本番が壊れていても気づけなかった。
 *
 * ここでは「通知が届く状態か」を隠さずに出す:
 *   - 送信先が未設定なら赤字で「どこにも通知できていません」と書く
 *   - 送った / 失敗した / 送信先未設定 をそのまま表示する（送ったふりをしない）
 *   - 通知は 15 分ごとのチェックなので最大 15 分遅れることも明記する
 *
 * どこで動くか: 運営サーバー (Fly.io) の cron。誰の費用か: 運営（無料枠内）。
 */

"use client";

import * as React from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellOff, BellRing } from "lucide-react";

import { ApiError, type ApiClient } from "@atelier/api-client";

import { createAuthedApiClient } from "../../../../lib/auth/connector";
import { Loading } from "../../../../components/Loading";

export interface AlertStateEntry {
  readonly fingerprint: string;
  readonly first_seen_at: string;
  readonly last_notified_at?: string | null;
  readonly notified_count: number;
  readonly reported_errors: number;
  readonly last_status: "pending" | "sent" | "failed" | "skipped";
  readonly last_detail?: string | null;
}

export interface AlertStatusResponse {
  readonly channels: readonly string[];
  readonly cooldown_minutes: number;
  readonly notify_warnings: boolean;
  readonly max_delay_minutes: number;
  readonly data: readonly AlertStateEntry[];
}

const CHANNEL_LABEL: Record<string, string> = {
  email: "メール",
  slack: "Slack",
};

const STATUS_LABEL: Record<AlertStateEntry["last_status"], string> = {
  sent: "送信済み",
  failed: "送信失敗（次回再試行）",
  skipped: "送信先が未設定のため未送信",
  pending: "未送信",
};

const STATUS_CLASS: Record<AlertStateEntry["last_status"], string> = {
  sent: "text-on-surface-variant",
  failed: "text-error font-semibold",
  skipped: "text-error font-semibold",
  pending: "text-on-surface-variant",
};

function formatAt(value?: string | null): string {
  if (!value) return "—";
  const at = new Date(value);
  return `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, "0")}:${String(
    at.getMinutes(),
  ).padStart(2, "0")}`;
}

export interface AlertStatusPanelProps {
  readonly client?: ApiClient;
}

export function AlertStatusPanel({ client: injected }: AlertStatusPanelProps) {
  const client = useMemo(() => injected ?? createAuthedApiClient(), [injected]);

  const query = useQuery({
    queryKey: ["admin-alerts"],
    queryFn: async () => {
      const res = await client.get("/admin/alerts", {
        params: { query: { limit: 50 } },
      });
      return res as AlertStatusResponse;
    },
    retry: false,
  });

  if (query.error instanceof ApiError && query.error.status === 403) return null;

  const status = query.data;
  const channels = status?.channels ?? [];
  const configured = channels.length > 0;

  return (
    <section
      aria-label="エラー通知"
      className="mt-6 overflow-hidden rounded-lg border border-border bg-white"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface-variant px-5 py-4">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-bold text-on-surface">
            {configured ? (
              <BellRing size={14} aria-hidden className="text-primary" />
            ) : (
              <BellOff size={14} aria-hidden className="text-error" />
            )}
            エラー通知
          </div>
          <div className="mt-0.5 text-[11.5px] text-on-surface-variant">
            記録されたエラーのうち新しいもの・増えているものを運営へ知らせます
          </div>
        </div>
      </div>

      {query.isLoading ? (
        <div className="px-5 py-6">
          <Loading message="通知の状態を読み込み中" />
        </div>
      ) : !status ? (
        <p className="px-5 py-6 text-[13px] text-on-surface-variant">
          通知の状態を取得できませんでした。
        </p>
      ) : (
        <>
          <dl className="grid gap-3 border-b border-border px-5 py-4 text-[12.5px] sm:grid-cols-3">
            <div>
              <dt className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-on-surface-variant">
                通知先
              </dt>
              <dd
                className={
                  configured
                    ? "mt-0.5 text-on-surface"
                    : "mt-0.5 font-semibold text-error"
                }
              >
                {configured
                  ? channels.map((c) => CHANNEL_LABEL[c] ?? c).join(" / ")
                  : "未設定 — どこにも通知できていません"}
              </dd>
            </div>
            <div>
              <dt className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-on-surface-variant">
                同じ不具合の再通知
              </dt>
              <dd className="mt-0.5 text-on-surface">
                {status.cooldown_minutes} 分に 1 回まで
              </dd>
            </div>
            <div>
              <dt className="text-[10.5px] font-bold uppercase tracking-[0.06em] text-on-surface-variant">
                通知の遅れ
              </dt>
              <dd className="mt-0.5 text-on-surface">
                最大 {status.max_delay_minutes} 分
              </dd>
            </div>
          </dl>

          {!configured ? (
            <p className="border-b border-border px-5 py-3 text-[12px] text-error">
              サーバーの環境変数 ATELIER_ALERT_EMAIL_TO（メール）または
              ATELIER_ALERT_SLACK_WEBHOOK_URL（Slack）を設定すると届くようになります。
              設定するまでは、下の一覧に「送信先が未設定のため未送信」と記録され続けます。
            </p>
          ) : null}

          {status.data.length === 0 ? (
            <p className="px-5 py-6 text-[13px] text-on-surface-variant">
              通知の記録はまだありません。
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12.5px]">
                <caption className="sr-only">エラー通知の送信状態</caption>
                <thead>
                  <tr className="border-b border-border text-left text-[10.5px] uppercase tracking-[0.06em] text-on-surface-variant">
                    <th className="px-4 py-2 font-bold">最終通知</th>
                    <th className="px-4 py-2 font-bold">状態</th>
                    <th className="px-4 py-2 font-bold">通知回数</th>
                    <th className="px-4 py-2 font-bold">伝えた件数</th>
                    <th className="px-4 py-2 font-bold">詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {status.data.map((r) => (
                    <tr
                      key={r.fingerprint}
                      className="border-b border-border last:border-b-0"
                    >
                      <td className="whitespace-nowrap px-4 py-2 tabular-nums text-on-surface-variant">
                        {formatAt(r.last_notified_at)}
                      </td>
                      <td
                        className={`whitespace-nowrap px-4 py-2 ${STATUS_CLASS[r.last_status]}`}
                      >
                        {STATUS_LABEL[r.last_status]}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-on-surface-variant">
                        {r.notified_count}
                      </td>
                      <td className="px-4 py-2 tabular-nums text-on-surface-variant">
                        {r.reported_errors}
                      </td>
                      <td className="px-4 py-2 text-on-surface-variant">
                        {r.last_detail ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
