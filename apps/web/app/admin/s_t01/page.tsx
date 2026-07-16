/**
 * S-T01 運営ダッシュボード画面 — T-UC-30
 *
 * 実 admin API (GET /admin/dashboard + /admin/audit-logs) に配線。運営 admin 専用。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { AdminDashboardContainer } from "./_components/AdminDashboardContainer";

export default function ST01Page() {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-[1200px] bg-surface p-lg">
      <QueryProvider>
        <AdminDashboardContainer />
      </QueryProvider>
    </div>
  );
}
