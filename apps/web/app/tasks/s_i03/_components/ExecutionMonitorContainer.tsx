/**
 * S-I03 実行モニター コンテナ — T-UC-16 (実 exec-logs SSE 配線)
 *
 * GET /executions/{id}/logs/stream の ExecLogEvent を逐次受け取り LogLine に変換して
 * ExecutionMonitor に流す。error イベント / 例外では inline error を表示。
 * streamFn は注入可能 (テスト用)。
 */

"use client";

import * as React from "react";
import { useEffect, useState } from "react";

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

  return (
    <div className="flex flex-col gap-sm">
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
  );
}
