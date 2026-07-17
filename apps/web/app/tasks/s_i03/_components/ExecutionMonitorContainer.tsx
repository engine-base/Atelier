/**
 * S-I03 実行モニター コンテナ — T-UC-16 (実 exec-logs SSE 配線)
 *
 * GET /executions/{id}/logs/stream の ExecLogEvent を逐次受け取り LogLine に変換して
 * ExecutionMonitor に流す。error イベント / 例外では inline error を表示。
 * streamFn は注入可能 (テスト用)。
 *
 * 見た目はモック 06_mockups/task/S-I03-monitor.html の「統計バー + セッションカード +
 * ライブログ」を踏襲する。統計値は受信済みログから算出した実データにバインドする
 * (モックのダミー件数は使わない)。SSE / state / container 分割ロジックは不変。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { Activity, AlertCircle, AlertTriangle, Terminal } from "lucide-react";

import { cn } from "../../../../lib/cn";
import { ExecutionMonitor, type LogLine } from "./ExecutionMonitor";
import {
  streamExecLogs,
  type ExecLogEvent,
  type StreamExecLogsArgs,
} from "./execStream";

type StreamFn = (args: StreamExecLogsArgs) => Promise<void>;

export interface ExecutionMonitorContainerProps {
  readonly executionId: string;
  readonly streamFn?: StreamFn;
}

function toLine(e: ExecLogEvent, seq: number): LogLine {
  const ts = e.timestamp ? e.timestamp.slice(11, 19) : "";
  const isError = e.type === "error" || Boolean(e.error_summary);
  const message = isError
    ? (e.error_summary ?? "エラーが発生しました")
    : e.type === "end"
      ? `実行終了（状態: ${e.status ?? "不明"}）`
      : `状態: ${e.status ?? e.type}`;
  return { id: `${seq}`, ts, level: isError ? "error" : "info", message };
}

/** モック統計バーの stat-card 相当。値は受信ログ由来の実データ。 */
function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly value: React.ReactNode;
  readonly sub: string;
  readonly tone: string;
}) {
  return (
    <div className="rounded-md border border-border bg-surface p-md shadow-sm">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-on-surface-variant">
        {icon}
        {label}
      </div>
      <div
        className={cn(
          "text-2xl font-extrabold leading-none tracking-tight tabular-nums",
          tone,
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] text-on-surface-variant">{sub}</div>
    </div>
  );
}

export function ExecutionMonitorContainer({
  executionId,
  streamFn = streamExecLogs,
}: ExecutionMonitorContainerProps) {
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let seq = 0;
    let active = true;
    setLines([]);
    setError(null);
    streamFn({
      executionId,
      signal: controller.signal,
      onEvent: (e) => {
        if (!active) return;
        seq += 1;
        const line = toLine(e, seq);
        setLines((prev) => [...prev, line]);
      },
    }).catch(() => {
      if (active)
        setError(
          "実行ログの取得に失敗しました。接続を確認して再試行してください。",
        );
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [executionId, streamFn]);

  const total = lines.length;
  const warnCount = lines.filter((l) => l.level === "warn").length;
  const errorCount = lines.filter((l) => l.level === "error").length;
  const connected = !error;
  const dotTone = error
    ? "bg-error"
    : warnCount > 0
      ? "bg-secondary"
      : "bg-tertiary";
  const stage = error
    ? { label: "接続エラー", tone: "bg-error/10 text-error" }
    : { label: "ライブ受信中", tone: "bg-tertiary-container text-tertiary-container-fg" };

  return (
    <div className="flex flex-col gap-md">
      {/* 統計バー — 受信ログ由来の実データ */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={<Terminal size={12} aria-hidden />}
          label="受信ログ"
          value={total}
          sub="ストリーム受信件数"
          tone="text-primary"
        />
        <StatCard
          icon={<AlertTriangle size={12} aria-hidden />}
          label="警告"
          value={warnCount}
          sub="warn レベル"
          tone="text-secondary"
        />
        <StatCard
          icon={<AlertCircle size={12} aria-hidden />}
          label="エラー"
          value={errorCount}
          sub="error レベル"
          tone="text-error"
        />
        <StatCard
          icon={<Activity size={12} aria-hidden />}
          label="接続"
          value={connected ? "接続中" : "切断"}
          sub={`実行 ${executionId}`}
          tone={connected ? "text-tertiary" : "text-error"}
        />
      </div>

      {/* セクション見出し */}
      <div className="flex items-center gap-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-tertiary bg-tertiary-container text-tertiary-container-fg">
          <Activity size={14} aria-hidden />
        </span>
        <div>
          <div className="text-body-md font-bold text-on-surface">
            ライブ実行ログ
          </div>
          <div className="text-body-sm text-on-surface-variant">
            Bridge が送信するイベントをリアルタイムに表示します
          </div>
        </div>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* セッションカード */}
      <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
        <div className="flex items-center gap-3 border-b border-border px-md py-3">
          <span
            aria-hidden
            className={cn("h-2.5 w-2.5 shrink-0 rounded-full animate-pulse", dotTone)}
          />
          <div className="min-w-0">
            <div className="truncate text-body-md font-bold text-on-surface">
              実行セッション
            </div>
            <div className="truncate text-body-sm text-on-surface-variant">
              セッション ID：{executionId}
            </div>
          </div>
          <span
            className={cn(
              "ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
              stage.tone,
            )}
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
            {stage.label}
          </span>
        </div>

        <div className="flex flex-col gap-sm p-md">
          {lines.length === 0 && !error ? (
            <p className="text-body-md text-on-surface-variant">ログを待機中…</p>
          ) : null}
          <ExecutionMonitor lines={lines} />
          {error ? (
            <p role="alert" className="text-body-sm text-error">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
