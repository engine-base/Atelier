/**
 * ToastViewport — グローバル toast ストアを購読して画面右下に重ねて表示する。
 *
 * QueryProvider 直下に置くことで、配下の全画面で query/mutation エラー時の toast を出す。
 */

"use client";

import * as React from "react";
import { useSyncExternalStore } from "react";

import { Toast } from "./toast";
import {
  dismissToast,
  getToastsServerSnapshot,
  getToastsSnapshot,
  subscribeToasts,
} from "../../lib/toast/store";

export function ToastViewport() {
  const toasts = useSyncExternalStore(
    subscribeToasts,
    getToastsSnapshot,
    getToastsServerSnapshot,
  );

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2"
      role="region"
      aria-label="通知"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast
            id={t.id}
            message={t.message}
            tone={t.tone}
            onClose={dismissToast}
          />
        </div>
      ))}
    </div>
  );
}
