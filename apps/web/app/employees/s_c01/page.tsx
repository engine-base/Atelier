/**
 * S-C01 AI 社員組織図画面 — T-UC-06
 *
 * 実 ai-employees API (GET /ai-employees) に配線。社員クリックで S-C02 編集へ遷移。
 */

"use client";

import * as React from "react";

import { useRouter } from "next/navigation";

import { QueryProvider } from "../../../providers/query-provider";
import { OrgChartContainer } from "./_components/OrgChartContainer";

function SC01Inner() {
  const router = useRouter();
  return (
    <div className="mx-auto w-full max-w-5xl px-md py-lg">
      <h1 className="mb-lg text-headline-md font-bold text-on-surface">
        AI 社員組織図
      </h1>
      <OrgChartContainer
        onSelect={(id) => router.push(`/employees/s_c02?employee=${id}`)}
      />
    </div>
  );
}

export default function SC01Page() {
  return (
    <QueryProvider>
      <SC01Inner />
    </QueryProvider>
  );
}
