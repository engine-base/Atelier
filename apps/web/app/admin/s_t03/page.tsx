/**
 * S-T03 AI 社員テンプレ画面 — T-UC-32
 *
 * 実 admin API (GET /admin/ai-employee-templates) に配線。運営 admin 専用・read-only。
 */

"use client";

import * as React from "react";

import { QueryProvider } from "../../../providers/query-provider";
import { TemplateListContainer } from "./_components/TemplateListContainer";

export default function ST03Page() {
  return (
    <div className="min-h-dvh bg-surface p-lg">
      <div className="mx-auto w-full max-w-[1200px]">
        <span className="admin-eyebrow inline-flex items-center rounded-sm bg-error px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] text-on-error">
          Admin
        </span>
        <h1 className="mb-md mt-2 text-headline-md font-bold tracking-tight text-on-surface">
          AI 社員テンプレート
        </h1>
        <QueryProvider>
          <TemplateListContainer />
        </QueryProvider>
      </div>
    </div>
  );
}
