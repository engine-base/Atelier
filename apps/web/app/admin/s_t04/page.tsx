/**
 * S-T04 ユーザー管理画面 — T-UC-33
 *
 * 実 admin API (GET /admin/users) に配線。運営 admin 専用・read-only。
 * F-VIS 是正: モック 06_mockups/admin/S-T04-users.html に忠実な本文へ再構築。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { UserAdminContainer } from "./_components/UserAdminContainer";

export default function ST04Page() {
  return (
    <div className="bg-surface min-h-dvh">
      <div className="mx-auto w-full max-w-[1200px] px-lg py-lg">
        <header className="mb-lg">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
            User Management
          </p>
          <h1 className="mt-1 text-3xl font-bold tracking-tight text-on-surface">
            ユーザー管理
          </h1>
          <p className="mt-1 text-body-md text-on-surface-variant">
            アカウント一覧 · ロール変更 · サポート対応 · 退会データ管理
          </p>
        </header>
        <QueryProvider>
          <UserAdminContainer />
        </QueryProvider>
      </div>
    </div>
  );
}
