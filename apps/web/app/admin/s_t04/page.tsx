/**
 * S-T04 ユーザー管理画面 — T-UC-33
 *
 * 実 admin API (GET /admin/users) に配線。運営 admin 専用・read-only。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { UserAdminContainer } from "./_components/UserAdminContainer";

export default function ST04Page() {
  return (
    <div className="bg-surface-fg min-h-dvh p-lg">
      <h1 className="mb-md text-headline-md font-bold text-surface">
        ユーザー管理
      </h1>
      <QueryProvider>
        <UserAdminContainer />
      </QueryProvider>
    </div>
  );
}
