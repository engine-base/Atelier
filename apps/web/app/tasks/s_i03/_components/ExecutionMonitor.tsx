/**
 * S-I03 実行モニター — ライブログ・コンソール (T-UC-16)
 *
 * モック 06_mockups/task/S-I03-monitor.html の `.session-log` を踏襲した
 * ダーク・モノスペースのログ行表示。level (info/warn/error/debug) で色分けする。
 * - 濃紺の面 (bg-surface-fg = #0F172A) にクリーム/トークン色の文字でコントラストを担保
 * - 各行: 時刻 (log-t 相当・muted) + レベル略号 + メッセージ
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

// モックの log-info(青) / log-ok/info(緑) / log-warn(琥珀) 相当をトークンで再現。
// 濃紺の面の上で可読なコントラストが出る container / error トークンを使う。
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "text-on-surface-variant",
  info: "text-primary-container",
  warn: "text-secondary-container",
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
      role="log"
      aria-live="polite"
      className="max-h-[280px] overflow-y-auto rounded-md bg-surface-fg p-md font-mono text-body-sm leading-relaxed"
    >
      <ul className="flex flex-col gap-xs">
        {lines.map((l) => (
          <li key={l.id} className="flex gap-sm">
            <time className="shrink-0 tabular-nums text-on-surface-variant">
              {l.ts}
            </time>
            <span className={cn("shrink-0 font-bold", LEVEL_COLOR[l.level])}>
              {LEVEL_LABEL[l.level]}
            </span>
            <span className={cn("min-w-0 break-words", LEVEL_COLOR[l.level])}>
              {l.message}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
