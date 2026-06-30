/**
 * S-I03 実行モニター (ダーク・SSE ログ) — T-UC-16
 *
 * - ダーク背景でログを行表示
 * - level (info/warn/error/debug) で色分け
 * - 実 SSE 連携は createRealtimeClient (Bundle D T-US-07) を別 PR で配線
 */

"use client";

import * as React from "react";

import { cn } from "../../../../lib/cn";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
  readonly id: string;
  readonly ts: string;
  readonly level: LogLevel;
  readonly message: string;
}

export interface ExecutionMonitorProps {
  readonly lines: readonly LogLine[];
}

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "text-surface-variant",
  info: "text-surface",
  warn: "text-secondary",
  error: "text-error",
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

export function ExecutionMonitor({ lines }: ExecutionMonitorProps) {
  return (
    <section
      aria-label="実行ログ"
      data-theme="dark"
      className="rounded-md bg-on-surface p-md font-mono text-body-sm"
    >
      <ul role="log" aria-live="polite" className="flex flex-col gap-xs">
        {lines.map((l) => (
          <li key={l.id} className="flex gap-sm">
            <time className="text-surface-variant">{l.ts}</time>
            <span className={cn("font-bold", LEVEL_COLOR[l.level])}>
              {LEVEL_LABEL[l.level]}
            </span>
            <span className="text-surface">{l.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
