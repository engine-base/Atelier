/**
 * S-T05 監査ログ画面 — T-UC-34
 *
 * 実 admin API (GET /admin/audit-logs) に配線。運営 admin 専用。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { AuditLogContainer } from "./_components/AuditLogContainer";

export default function ST05Page() {
  return (
    <div className="bg-surface-fg min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">
        監査ログ
      </h1>
      <QueryProvider>
        <AuditLogContainer />
      </QueryProvider>
    </div>
  );
}
