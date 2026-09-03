"use client";

/**
 * GAP-297 (通し J60-06): 描画エラー (ErrorBoundary) 以外の失敗 —
 * イベントハンドラ・非同期処理・Promise の未処理拒否 — も自前のエラーログ
 * (POST /client-errors) に届ける。
 *
 * 以前は ErrorBoundary だけだったので、ボタンを押した先で落ちた JS エラーは
 * 運営に一切届かなかった。外部 SaaS には送らない (GAP-182 の判断どおり)。
 */

import { useEffect } from "react";

import { reportClientError } from "../lib/report-client-error";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

export function GlobalErrorReporter(): null {
  useEffect(() => {
    let sentAt: number[] = [];
    const allowed = (): boolean => {
      const now = Date.now();
      sentAt = sentAt.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (sentAt.length >= RATE_LIMIT_MAX) return false;
      sentAt.push(now);
      return true;
    };
    const onError = (ev: ErrorEvent): void => {
      if (!allowed()) return;
      const err = ev.error instanceof Error ? ev.error : null;
      void reportClientError({
        kind: err?.name || "WindowError",
        message: err?.message || ev.message || "unknown error",
        path: window.location.pathname,
        ...(err?.stack ? { stack: err.stack } : {}),
      });
    };
    const onRejection = (ev: PromiseRejectionEvent): void => {
      if (!allowed()) return;
      const reason: unknown = ev.reason;
      const err = reason instanceof Error ? reason : null;
      void reportClientError({
        kind: err?.name || "UnhandledRejection",
        message: err?.message || (typeof reason === "string" ? reason : "unhandled rejection"),
        path: window.location.pathname,
        ...(err?.stack ? { stack: err.stack } : {}),
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
