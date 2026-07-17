/**
 * S-T05 監査ログ画面 — T-UC-34
 *
 * 実 admin API (GET /admin/audit-logs) に配線。運営 admin 専用。
 * 本文はモック 06_mockups/admin/S-T05-audit.html に忠実。ヘッダ(eyebrow/title/subtitle/
 * CSV エクスポート) は状態非依存で常時表示、集計カード・フィルタ・ログ表は Container 経由で描画。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { AuditLogContainer } from "./_components/AuditLogContainer";

export default function ST05Page() {
  return (
    <div className="mx-auto w-full max-w-[1200px] bg-surface p-lg">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            Audit Log
          </div>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-on-surface">
            監査ログ
          </h1>
          <p className="mt-1 text-body-md text-on-surface-variant">
            全操作の証跡（1 年保持） · 個人情報閲覧 · AI 書込 · システム自動処理
          </p>
        </div>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-primary px-4 py-2 text-sm font-semibold text-primary transition-colors hover:bg-primary-container focus-visible:outline-2 focus-visible:outline-primary"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          CSV エクスポート
        </button>
      </div>
      <QueryProvider>
        <AuditLogContainer />
      </QueryProvider>
    </div>
  );
}
