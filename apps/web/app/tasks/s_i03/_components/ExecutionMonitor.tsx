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
      // 旧実装は bg-on-surface (未定義クラス=透過) で、クリーム地に
      // クリーム文字 (コントラスト 1.09・ほぼ不可視) になる実バグが axe 実機で出た。
      // config で有効な bg-surface-fg (濃紺 #0F172A) + surface 系クリーム文字にする。
      role="log"
      aria-live="polite"
      className="rounded-md bg-surface-fg p-md font-mono text-body-sm"
    >
      <ul className="flex flex-col gap-xs">
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
