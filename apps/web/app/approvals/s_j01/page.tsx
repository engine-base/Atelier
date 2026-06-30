/**
 * S-J01 承認待ち（5 種統合）— T-UC-17
 *
 * 実 approval-inbox API に配線。本人の承認待ちを取得し承認 / 差戻する。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { ApprovalsContainer } from "./_components/ApprovalsContainer";

export default function SJ01Page() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-lg px-md py-lg">
      <h1 className="text-headline-md font-bold text-on-surface">承認待ち</h1>
      <QueryProvider>
        <ApprovalsContainer />
      </QueryProvider>
    </div>
  );
}
