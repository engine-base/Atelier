/**
 * 横断: 通知センター — T-UC-36
 *
 * 本人の承認待ち（GET /approval-inbox, RLS 本人限定）を通知として一覧表示する。
 * 既読は localStorage 管理。専用 notifications テーブル + RLS（R-T08 致命級）は
 * 別 migration に切り出し、本 MVP では既存データの集約に留める。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../providers/query-provider";
import { NotificationsContainer } from "./_components/NotificationsContainer";

export default function UC36Page() {
  return (
    <QueryProvider>
      <NotificationsContainer />
    </QueryProvider>
  );
}
